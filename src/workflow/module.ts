import type { TelegramStore } from '../telegram/store.js';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { registerTransports } from '../hermes/module.js';
import { registerStatus } from '../hermes/status.js';
import { DomainError } from '../shared/api.js';
import type { ApplicationModule, PlatformServices } from '../shared/ports.js';
import type { ServiceStatus } from '../shared/domain.js';
import { createOpenAIExtractor } from '../intelligence/openai.js';
import {LARGE_EXTRACTION_TIMEOUT_MS}from'../intelligence/extraction-budget.js';
import { createOpenAIDecisions } from '../intelligence/openai-decisions.js';
import { createJevAdapter } from '../intelligence/jev.js';
import { SqlAnalysisQueue, type AnalysisClaimOptions } from './analysis.js';
import { RecordsRepository } from './records.js';
import { processAnalysisOnce } from './processor.js';
import { ProposalRepository } from './proposals.js';
import { SqlMutationStore } from './mutations.js';
import { ProposalWorkflow } from './apply.js';
import { TicketProjector } from './projection.js';
import { resetJevBreaker, seedKnownJevRestriction, withDurableJevBreaker } from './breaker.js';
import { OutreachWorkflow } from '../outreach/service.js';
import { OutreachPublisher } from '../outreach/publisher.js';
import { outreachPage, nativeOutreachPage } from '../outreach/page.js';
import { NativeProposalWorkflow } from '../board/native-workflow.js';
import { registerBoard } from '../board/routes.js';

export function createWorkflowServices(platform: PlatformServices) {
  const native = platform.config.boardBackend === 'native';
  const outreach = new OutreachWorkflow(platform.db, platform.clock, platform.config.jev,{nativeBoard:native,vikunjaPublicUrl:platform.config.vikunja.publicUrl??platform.config.vikunja.baseUrl});
  const outreachPublisher = new OutreachPublisher(platform.db, platform.config.vikunja, outreach);
  const records = new RecordsRepository(platform.db, platform.clock, platform.config.timezone);
  const proposalRecords = new ProposalRepository(platform.db, platform.control, platform.clock);
  const mutations = new SqlMutationStore(platform.db, platform.clock);
  const projector = new TicketProjector(platform.db, platform.vikunja, records, platform.clock);
  const proposals = native ? new NativeProposalWorkflow(proposalRecords) : new ProposalWorkflow(proposalRecords, mutations, platform.vikunja, projector);
  const analysis = new SqlAnalysisQueue(platform.db, platform.clock, platform.config.timezone, {
    onDecision: (tx, input) => proposalRecords.recordAnalysisDecisionTx(tx, input), onReplay: resetJevBreaker,
  });
  const extraction = createOpenAIExtractor(platform.config.extraction, { clock: platform.clock });
  const jev = withDurableJevBreaker(platform.db, (platform.config.jev.provider === 'openai' ? createOpenAIDecisions : createJevAdapter)(platform.config.jev, { clock: platform.clock }), platform.config, platform.clock);
  return { outreachPublisher, records, analysis, extraction, jev, proposals, proposalRecords, mutations, projector, outreach,
    processOnce: (options: AnalysisClaimOptions & { signal?: AbortSignal }) => processAnalysisOnce({ queue: analysis, extraction, jev }, options) };
}

/** Register before platform start; run bounded work only after its complete migration ledger exists. */
export async function createWorkflowModule(platform: PlatformServices): Promise<ApplicationModule> {
  const services = createWorkflowServices(platform);
  const directory = new URL('../../db/migrations/', import.meta.url);
  const names = (await readdir(directory)).filter((name) => /^\d[\w.-]*\.sql$/.test(name));
  const expectedMigrations = new Map(await Promise.all(names.map(async (name) => [name, createHash('sha256').update(await readFile(new URL(name, directory))).digest('hex')] as const)));
  let stopping: Promise<void> | null = null;
  let started = false, stopped = false, timer: ReturnType<typeof setTimeout> | null = null, task: Promise<void> | null = null;
  let nextOutreachSweep = 0;
  let outreachTimer: ReturnType<typeof setTimeout> | null = null, outreachTask: Promise<void> | null = null;
  let outreachFailed = false;
  const analysisTasks = new Set<Promise<void>>(), analysisTimers = new Set<ReturnType<typeof setTimeout>>();
  const analysisFailed = [false, false];
  let transports: ReturnType<typeof registerTransports> | null = null;
  let unsubscribe: (() => void) | null = null; const replies = new Set<Promise<void>>(); const abort = new AbortController();
  let state: ServiceStatus = { state: 'connecting', code: 'not_started', detail: 'Workflow has not started', checkedAt: platform.clock.now().toISOString() };
  async function migrationsReady(): Promise<'pending' | 'ready' | 'drift'> {
    return platform.db.transaction(async (tx) => {
      const lock = (await tx.query<{ ready: boolean }>("SELECT pg_try_advisory_xact_lock_shared(hashtextextended('antseed:migrations',0)) AS ready")).rows[0]; if (!lock?.ready) return 'pending';
      if (!(await tx.query<{ name: string | null }>("SELECT to_regclass(quote_ident(current_schema())||'.schema_migrations')::text AS name")).rows[0]?.name) return 'pending';
      const applied = (await tx.query<{ version: string; checksum: string }>('SELECT version,checksum FROM schema_migrations')).rows;
      if (applied.some((row) => expectedMigrations.get(row.version) !== row.checksum)) return 'drift';
      return applied.length === expectedMigrations.size ? 'ready' : 'pending';
    });
  }
  async function requireDatabaseReady(): Promise<void> {
    try {
      const result = await migrationsReady();
      if (result === 'ready') return;
      throw new DomainError('upstream_unavailable', result === 'drift' ? 'Applied migration checksum differs from disk; business work is paused' : 'Waiting for checksum-validated database migrations', true);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('upstream_unavailable', 'Database readiness unavailable; business work is paused', true);
    }
  }
  async function tick(): Promise<void> {
    if (abort.signal.aborted) return;
    try {
      const readiness = await migrationsReady();
      if (readiness !== 'ready') { state = { state: readiness === 'drift' ? 'unavailable' : 'connecting', code: readiness === 'drift' ? 'migration_drift' : 'database_pending', detail: readiness === 'drift' ? 'Applied migration checksum differs from disk; workflow remains stopped' : 'Waiting for checksum-validated platform migrations', checkedAt: platform.clock.now().toISOString() }; return; }
      abort.signal.throwIfAborted();
      await seedKnownJevRestriction(platform.db, platform.config, platform.clock);
      let phaseFailed = false;
      async function phase(work: () => Promise<unknown>) { try { abort.signal.throwIfAborted(); await work(); } catch { phaseFailed = true; abort.signal.throwIfAborted(); } }
      await phase(() => services.proposalRecords.recoverDecisionIntents());
      await phase(() => services.proposalRecords.placeInitialAutomatically(5));
      await phase(() => services.proposalRecords.flushPendingControl(20));
      if (platform.config.boardBackend !== 'native') await phase(() => services.projector.retireUnapprovedBatch(5, abort.signal));
      // Remote board observation remains prompt without continuously rereading
      // every card through the external Supabase-backed Vikunja deployment.
      if (platform.config.boardBackend !== 'native') await phase(() => services.projector.projectBatch(5, abort.signal, 300_000));
      await phase(() => services.proposals.applyNext(abort.signal));
      const providers = await Promise.all([services.extraction.status(), services.jev.status()]);
      const waiting = (await platform.db.query("SELECT 1 FROM proposals WHERE decision='pending' AND last_error='control_chat_missing' LIMIT 1")).rows.length > 0;
      const workerFailed = phaseFailed || outreachFailed || analysisFailed.some(Boolean);
      const degraded = workerFailed || waiting || providers.some((p) => p.state !== 'ready');
      state = { state: degraded ? 'degraded' : 'ready', code: waiting ? 'control_chat_missing' : workerFailed ? 'workflow_retry' : degraded ? 'provider_pending_or_unavailable' : null,
        detail: waiting ? 'Pending proposals await an explicitly configured control group' : degraded ? 'Workers running; provider configuration/access remains incomplete' : 'Workflow workers running', checkedAt: platform.clock.now().toISOString() };
    } catch {
      if (!abort.signal.aborted) state = { state: 'degraded', code: 'workflow_retry', detail: 'Bounded workflow task failed; durable state retained for retry', checkedAt: platform.clock.now().toISOString() };
    }
  }
  function schedule(): void {
    if (stopped) return;
    task = tick().finally(() => { task = null; if (!stopped) { timer = setTimeout(schedule, 1000); timer.unref(); } });
  }
  function scheduleOutreach(): void {
    if (stopped) return;
    outreachTask = (async () => {
      if (await migrationsReady() !== 'ready' || abort.signal.aborted) return;
      let failed = false;
      const phase = async (work: () => Promise<unknown>) => {
        try { abort.signal.throwIfAborted(); await work(); }
        catch { failed = true; abort.signal.throwIfAborted(); }
      };
      const sweep = platform.clock.now().getTime() >= nextOutreachSweep;
      if (sweep) {
        nextOutreachSweep = platform.clock.now().getTime() + 30_000;
        await phase(() => services.outreach.reconcile(5));
      }
      await phase(() => services.outreach.refreshDetails());
      if (platform.config.boardBackend !== 'native') await phase(() => services.outreachPublisher.tick(abort.signal));
      if (sweep && (await platform.db.query("SELECT mode FROM outreach_board_binding WHERE singleton")).rows[0]?.mode === 'publish') {
        await phase(() => services.outreach.assessNext(abort.signal));
      }
      outreachFailed = failed;
    })().catch(() => { if (!abort.signal.aborted) outreachFailed = true; }).finally(() => {
      outreachTask = null;
      if (!stopped) { outreachTimer = setTimeout(scheduleOutreach, 1000); outreachTimer.unref(); }
    });
  }
  function scheduleAnalysis(slot: 0 | 1): void {
    if (stopped) return;
    // One reserved live slot cannot be occupied by imported historical work.
    // The general slot still uses durable fair ordering and SKIP LOCKED claims.
    const work = (async () => {
      try {
        if (await migrationsReady() !== 'ready' || abort.signal.aborted) return;
        await seedKnownJevRestriction(platform.db, platform.config, platform.clock);
        abort.signal.throwIfAborted();
        await services.processOnce({ workerId: slot === 0 ? 'workflow:history' : 'workflow:outbound', recentOutboundOnly: slot === 1,
          leaseMs: Math.max(120000, Math.max(platform.config.extraction.timeoutMs,LARGE_EXTRACTION_TIMEOUT_MS) * platform.config.extraction.maxAttempts + platform.config.jev.timeoutMs * platform.config.jev.maxAttempts + 60000), signal: abort.signal });
        analysisFailed[slot] = false;
      } catch { if (!abort.signal.aborted) analysisFailed[slot] = true; }
    })();
    analysisTasks.add(work);
    void work.finally(() => {
      analysisTasks.delete(work);
      if (!stopped) {
        const next = setTimeout(() => { analysisTimers.delete(next); scheduleAnalysis(slot); }, 1000);
        analysisTimers.add(next); next.unref();
      }
    });
  }
  function stop(): Promise<void> {
    if (stopping) return stopping;
    stopped = true; abort.abort(new Error('Workflow stopping')); if (timer) clearTimeout(timer); if (outreachTimer) clearTimeout(outreachTimer);
    for (const analysisTimer of analysisTimers) clearTimeout(analysisTimer); analysisTimers.clear();
    const errors: unknown[] = [];
    try { unsubscribe?.(); } catch (error) { errors.push(error); } finally { unsubscribe = null; }
    // Publish one shutdown promise for preClose, root onClose and direct callers.
    // All captured work drains even if an earlier cleanup action fails.
    stopping = Promise.allSettled([transports?.close(), task, outreachTask, ...analysisTasks, ...replies]).then((results) => {
      for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
      if (errors.length) throw new AggregateError(errors, 'Workflow shutdown failed');
    });
    return stopping;
  }
  return {
    name: 'workflow',
    async register(app) {
      if (unsubscribe || stopped) return;
      // Fastify onClose runs after active HTTP drains. Begin workflow stop in
      // preClose so SDK sockets cannot block the cleanup that closes them.
      app.addHook('preClose', stop);
      app.get('/outreach', async (_request, reply) => reply.header('Cache-Control', 'no-store').type('text/html').send(platform.config.boardBackend === 'native' ? nativeOutreachPage : outreachPage));
      if (platform.config.boardBackend === 'native') registerBoard(app,platform.db,services.outreach,requireDatabaseReady,platform.config.timezone,{work:services.proposalRecords,intake:platform.chats as TelegramStore});
      transports = registerTransports(app, { chats: platform.chats, records: services.records, proposals: services.proposals, analysis: services.analysis, outreach: services.outreach }, requireDatabaseReady);
      registerStatus(app, async () => {
        const safe = async (read: () => Promise<ServiceStatus>): Promise<ServiceStatus> => {
          try { return await read(); } catch (error) {
            const absent = error && typeof error === 'object' && 'code' in error && error.code === '42P01';
            return { state: absent ? 'connecting' : 'unavailable', code: absent ? 'database_pending' : 'database_unavailable', detail: absent ? 'Provider status awaits validated migrations' : 'Provider status unavailable while database is unavailable', checkedAt: platform.clock.now().toISOString() };
          }
        };
        const [extraction, jev] = await Promise.all([safe(() => services.extraction.status()), safe(() => services.jev.status())]);
        const sales=await safe(async()=>{const s=await services.outreach.status();return {state:s.unresolved_requests!=='0'&&Number(s.unresolved_requests)>0?'degraded':s.mode==='publish'&&s.state==='ready'?'ready':'connecting',code:Number(s.unresolved_requests)>0?'publication_unresolved':s.mode!=='publish'?'observe_only':null,detail:`Sales board ${s.state}; ${s.pending_proposals} proposals; ${s.pending_publications} publications; ${s.unresolved_requests} unresolved requests`,checkedAt:platform.clock.now().toISOString()};});
        return { workflow: { ...state }, extraction, jev, outreach:sales };
      });
      const operational = async (message:import('../shared/ports.js').ControlMessage) => {
        if (stopped) throw new Error('Workflow stopping; retain inbox reply');
        if (platform.config.boardBackend === 'native' && !(await platform.db.query("SELECT 1 FROM workspace_members WHERE telegram_user_id=$1 AND enabled AND role IN ('admin','crm_manager')",[message.senderId])).rowCount) return;
        const reply = requireDatabaseReady().then(() => services.proposals.handleControlReply(message)); replies.add(reply);
        try { await reply; } finally { replies.delete(reply); }
      };
      if(platform.control.subscribeOwner){
        const offWork=platform.control.subscribeOwner('operational',operational);
        const offSales=platform.control.subscribeOwner('outreach',async message=>{if(stopped)throw new Error('Workflow stopping');const reply=requireDatabaseReady().then(()=>services.outreach.handleControlReply(message));replies.add(reply);try{await reply;}finally{replies.delete(reply);}},id=>services.outreach.isProposalCurrent(id));
        unsubscribe=()=>{offSales();offWork();};
      }else unsubscribe=platform.control.subscribe(operational);
    },
    async start() { if (started || stopped) return; started = true; schedule(); scheduleOutreach(); scheduleAnalysis(0); scheduleAnalysis(1); },
    stop,
    async status() { return { ...state }; },
  };
}
