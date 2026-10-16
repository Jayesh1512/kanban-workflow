import { readdir } from 'node:fs/promises';
import type { ApplicationModule, PlatformServices } from '../shared/ports.js';
import type { ServiceStatus } from '../shared/domain.js';
import { createOpenAIExtractor } from '../intelligence/openai.js';
import { createJevAdapter } from '../intelligence/jev.js';
import { SqlAnalysisQueue } from './analysis.js';
import { RecordsRepository } from './records.js';
import { processAnalysisOnce } from './processor.js';
import { ProposalRepository } from './proposals.js';
import { SqlMutationStore } from './mutations.js';
import { ProposalWorkflow } from './apply.js';
import { TicketProjector } from './projection.js';
import { resetJevBreaker, seedKnownJevRestriction, withDurableJevBreaker } from './breaker.js';

export function createWorkflowServices(platform: PlatformServices) {
  const records = new RecordsRepository(platform.db, platform.clock, platform.config.timezone);
  const proposalRecords = new ProposalRepository(platform.db, platform.control, platform.clock);
  const mutations = new SqlMutationStore(platform.db, platform.clock);
  const projector = new TicketProjector(platform.db, platform.vikunja, records, platform.clock);
  const proposals = new ProposalWorkflow(proposalRecords, mutations, platform.vikunja, projector);
  const analysis = new SqlAnalysisQueue(platform.db, platform.clock, platform.config.timezone, {
    onDecision: (tx, input) => proposalRecords.recordAnalysisDecisionTx(tx, input), onReplay: resetJevBreaker,
  });
  const extraction = createOpenAIExtractor(platform.config.extraction, { clock: platform.clock });
  const jev = withDurableJevBreaker(platform.db, createJevAdapter(platform.config.jev, { clock: platform.clock }), platform.config, platform.clock);
  return { records, analysis, extraction, jev, proposals, proposalRecords, mutations, projector,
    processOnce: (options: { workerId: string; leaseMs: number; signal?: AbortSignal }) => processAnalysisOnce({ queue: analysis, extraction, jev }, options) };
}

/** Register before platform start; run bounded work only after its complete migration ledger exists. */
export async function createWorkflowModule(platform: PlatformServices): Promise<ApplicationModule> {
  const services = createWorkflowServices(platform);
  const expectedMigrations = (await readdir(new URL('../../db/migrations/', import.meta.url))).filter((name) => /^\d[\w.-]*\.sql$/.test(name));
  let started = false, stopped = false, timer: ReturnType<typeof setTimeout> | null = null, task: Promise<void> | null = null;
  let unsubscribe: (() => void) | null = null; const replies = new Set<Promise<void>>(); const abort = new AbortController();
  let state: ServiceStatus = { state: 'connecting', code: 'not_started', detail: 'Workflow has not started', checkedAt: platform.clock.now().toISOString() };
  async function migrationsReady(): Promise<boolean> {
    return platform.db.transaction(async (tx) => {
      const lock = (await tx.query<{ ready: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended('antseed:migrations',0)) AS ready")).rows[0]; if (!lock?.ready) return false;
      if (!(await tx.query<{ name: string | null }>("SELECT to_regclass('schema_migrations')::text AS name")).rows[0]?.name) return false;
      const applied = (await tx.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version);
      return expectedMigrations.every((name) => applied.includes(name));
    });
  }
  async function tick(): Promise<void> {
    if (abort.signal.aborted) return;
    try {
      if (!await migrationsReady()) { state = { state: 'connecting', code: 'database_pending', detail: 'Waiting for platform migrations', checkedAt: platform.clock.now().toISOString() }; return; }
      abort.signal.throwIfAborted();
      await seedKnownJevRestriction(platform.db, platform.config, platform.clock);
      let phaseFailed = false;
      async function phase(work: () => Promise<unknown>) { try { abort.signal.throwIfAborted(); await work(); } catch { phaseFailed = true; abort.signal.throwIfAborted(); } }
      await phase(() => services.proposalRecords.recoverDecisionIntents());
      await phase(() => services.proposalRecords.flushPendingControl(20));
      await phase(() => services.projector.projectBatch(5, abort.signal));
      await phase(() => services.proposals.applyNext(abort.signal));
      await phase(() => services.processOnce({ workerId: 'workflow', leaseMs: Math.max(120000, platform.config.extraction.timeoutMs * platform.config.extraction.maxAttempts + platform.config.jev.timeoutMs * platform.config.jev.maxAttempts + 60000), signal: abort.signal }));
      const providers = await Promise.all([services.extraction.status(), services.jev.status()]);
      const waiting = (await platform.db.query("SELECT 1 FROM proposals WHERE decision='pending' AND last_error='control_chat_missing' LIMIT 1")).rows.length > 0;
      const degraded = phaseFailed || waiting || providers.some((p) => p.state !== 'ready');
      state = { state: degraded ? 'degraded' : 'ready', code: waiting ? 'control_chat_missing' : phaseFailed ? 'workflow_retry' : degraded ? 'provider_pending_or_unavailable' : null,
        detail: waiting ? 'Pending proposals await an explicitly configured control group' : degraded ? 'Workers running; provider configuration/access remains incomplete' : 'Workflow workers running', checkedAt: platform.clock.now().toISOString() };
    } catch {
      if (!abort.signal.aborted) state = { state: 'degraded', code: 'workflow_retry', detail: 'Bounded workflow task failed; durable state retained for retry', checkedAt: platform.clock.now().toISOString() };
    }
  }
  function schedule(): void {
    if (stopped) return;
    task = tick().finally(() => { task = null; if (!stopped) { timer = setTimeout(schedule, 1000); timer.unref(); } });
  }
  return {
    name: 'workflow',
    async register() {
      if (unsubscribe || stopped) return;
      unsubscribe = platform.control.subscribe(async (message) => {
        if (stopped) throw new Error('Workflow stopping; retain inbox reply');
        const reply = services.proposals.handleControlReply(message); replies.add(reply);
        try { await reply; } finally { replies.delete(reply); }
      });
    },
    async start() { if (started || stopped) return; started = true; schedule(); },
    async stop() { if (stopped) return; stopped = true; abort.abort(new Error('Workflow stopping')); if (timer) clearTimeout(timer); unsubscribe?.(); unsubscribe = null; await task; await Promise.allSettled([...replies]); },
    async status() { return { ...state }; },
  };
}
