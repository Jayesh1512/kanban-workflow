import { AutomaticIntake } from '../../src/telegram/automatic-intake.js';
import { decisionFixture } from '../intelligence/fixtures.js';
import { AsyncResource } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import Fastify from 'fastify';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PgDatabase, migrate } from '../../src/platform/database.js';
import { loadRuntimeConfig } from '../../src/platform/config.js';
import { VikunjaAdapter } from '../../src/vikunja/adapter.js';
import type { QueryResultRow } from 'pg';
import { TelegramStore } from '../../src/telegram/store.js';
import { TicketProjector } from '../../src/workflow/projection.js';
import { RecordsRepository } from '../../src/workflow/records.js';
import { DurableControlBus } from '../../src/telegram/control.js';
import { ProposalRepository } from '../../src/workflow/proposals.js';
import { createWorkflowModule } from '../../src/workflow/module.js';
import type { Database, PlatformServices, RuntimeConfig, SqlExecutor, TelegramPort } from '../../src/shared/ports.js';
import { inputFixture, jobId, sourceText } from '../intelligence/fixtures.js';
import { seedJob } from './database.js';
import { workflowHarness } from './harness.js';
import { testVikunjaToken } from '../vikunja-test-auth.js';

const project = process.env['WORKFLOW_TEST_PROJECT'];
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
// Explicit synthetic Docker project only. No Telegram, AI credentials or AI network calls.
describe.skipIf(!project)('M3.2 actual PostgreSQL + pinned Vikunja', () => {
  let config: RuntimeConfig, admin: PgDatabase;
  const cleanup: (() => Promise<unknown>)[] = [];
  beforeAll(async () => {
    if (!/^antseed-(?:b-(?:m32|m4)|qa-m1-system)-[a-z0-9-]+$/.test(project!)) throw new Error('Require an explicitly isolated workflow/system synthetic project');
    const args = ['compose', '-p', project!, '-f', 'compose.yaml']; const override = process.env['WORKFLOW_TEST_COMPOSE_OVERRIDE']; if (override) args.push('-f', override);
    // Capture runtime-generated test service secrets only in memory; never print them.
    const bundle = parse(execFileSync('docker', [...args, 'exec', '-T', 'vikunja', 'cat', '/run/antseed/runtime.env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    config = await loadRuntimeConfig({ ...bundle, AI_ENV_PATH: '/workflow-test-no-ai-file', DATABASE_URL: bundle['DATABASE_URL']!.replace('postgres:5432', `127.0.0.1:${process.env['WORKFLOW_TEST_PG_PORT']}`), VIKUNJA_URL: process.env['WORKFLOW_TEST_VIKUNJA_URL']! });
    // One login for this synthetic suite avoids hitting Vikunja's native login limiter
    // merely because isolated SQL schemas use separate adapter instances.
    await testVikunjaToken(config.vikunja);
    admin = new PgDatabase(config.databaseUrl);
  });
  afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
  afterAll(async () => { await admin?.close(); });
  async function fixture() {
    const schema = `m32_${randomUUID().replaceAll('-', '')}`; await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(config.databaseUrl); url.searchParams.set('options', `-c search_path=${schema}`);
    const db = new PgDatabase(url.toString()); cleanup.push(async () => { await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); });
    await migrate(db); await db.query('INSERT INTO telegram_account(self_user_id) VALUES(99)');
    await db.query("INSERT INTO chats(id,kind,title,inclusion) VALUES(-1001,'supergroup','Synthetic Cedar Labs','included')");
    const message = inputFixture().messages[0]!;
    await db.query('INSERT INTO messages(chat_id,id,sender_id,sent_at,text,sender_snapshot,peer_snapshot,forward_metadata) VALUES(-1001,1,7,$1,$2,$3,$4,$5)', [message.sentAt, sourceText, message.sender, message.peer, message.forward]); await seedJob(db, jobId);
    const adapter = new VikunjaAdapter(config.vikunja, db); const board = await adapter.ensureBoard();
    const h = await workflowHarness({ db, vikunja: adapter }); const p = await h.propose();
    await h.service.decide({ idempotencyKey: 'approve', proposalId: p.id, decision: 'approve' });
    return { ...h, db, schema, board, adapter, proposal: p };
  }
  it('automatically places the initial AI recommendation on real Vikunja without a control approval; later changes stay pending', async()=>{
    const h=await fixture();await h.configureControl();await h.db.query("UPDATE proposals SET apply_state='stale' WHERE id=$1",[h.proposal.id]);
    const cutoff='2026-10-04T18:30:00Z';await h.db.query("INSERT INTO app_settings(key,value) VALUES('telegram:automatic-since',$1)",[JSON.stringify({enabled:true,revision:'native-initial',cutoff,initialPlacement:true,groupApprovalFrom:'2026-10-23T13:48:42.677Z'})]);
    await h.db.query("INSERT INTO telegram_conversation_starts(chat_id,state,first_message_at,checked_cutoff) VALUES(-1001,'qualifies','2026-10-05',$1)",[cutoff]);
    const decision=decisionFixture(h.evidenceId);decision.diagnostics.rubricVersion='openai.decisions.antseed.v3';decision.lane={outcome:'propose',targetLane:'Integrations',reason:'Authored initial pilot evidence',nextAction:null,evidenceIds:[h.evidenceId]};
    const job=randomUUID();await h.db.query("INSERT INTO analysis_jobs(id,chat_id,policy_version,mapping_version,dedupe_key,status,decision) SELECT $1::uuid,id,policy_version,mapping_version,($1::uuid)::text,'completed',$2 FROM chats WHERE id=-1001",[job,JSON.stringify(decision)]);
    await h.db.transaction(tx=>h.proposals.recordAnalysisDecisionTx(tx,{jobId:job,ticketId:h.ticket.id,expectedStageVersion:0,decision}));
    const initial=(await h.db.query("SELECT id FROM proposals WHERE id<>$1",[h.proposal.id])).rows[0]!.id;
    expect((await h.db.query('SELECT 1 FROM control_outbox WHERE proposal_id=$1',[initial])).rowCount).toBe(0);
    expect(await h.proposals.placeInitialAutomatically()).toBe(1);expect(await h.proposals.placeInitialAutomatically()).toBe(0);
    await h.service.applyNext();const ticket=await h.records.getTicket(h.ticket.id);expect(ticket).toMatchObject({lane:'Integrations',stageVersion:1});expect((await h.adapter.getTask(ticket.vikunjaTaskId!))!.bucketId).toBe(h.board.buckets.Integrations);
    expect((await h.db.query('SELECT source FROM proposal_decisions WHERE proposal_id=$1',[initial])).rows[0]).toEqual({source:'automation'});
    const evidence=randomUUID();await h.db.query("INSERT INTO messages(chat_id,id,sent_at,text) VALUES(-1001,999,now()+interval '1 minute','Fresh later deployment update')");
    await h.db.query("INSERT INTO evidence(id,chat_id,message_id,message_version,excerpt,observed_at) VALUES($1,-1001,999,1,'Fresh later deployment update',now())",[evidence]);
    decision.lane={outcome:'propose',targetLane:'Completed',reason:'Authored later update',nextAction:null,evidenceIds:[evidence]};
    await h.db.transaction(tx=>h.proposals.recordAnalysisDecisionTx(tx,{jobId:randomUUID(),ticketId:ticket.id,expectedStageVersion:1,decision}));
    expect(await h.proposals.placeInitialAutomatically()).toBe(0);expect((await h.db.query("SELECT 1 FROM proposals p JOIN control_outbox o ON o.proposal_id=p.id WHERE p.decision='pending' AND p.target_lane='Completed'")).rowCount).toBe(1);
    expect((await h.adapter.getTask(ticket.vikunjaTaskId!))!.bucketId).toBe(h.board.buckets.Integrations);
  },30000);
  it('keeps a future group initial recommendation pending on real PostgreSQL/Vikunja until its control reply approves it',async()=>{
    const h=await fixture();await h.configureControl();await h.db.query("UPDATE proposals SET apply_state='stale' WHERE id=$1",[h.proposal.id]);
    const cutoff='2026-10-04T18:30:00Z',groupApprovalFrom='2026-10-23T13:48:42.677Z';
    await h.db.query("INSERT INTO app_settings(key,value) VALUES('telegram:automatic-since',$1)",[JSON.stringify({enabled:true,revision:'future-group-native',cutoff,initialPlacement:true,groupApprovalFrom})]);
    await h.db.query("INSERT INTO telegram_conversation_starts(chat_id,state,first_message_at,checked_cutoff) VALUES(-1001,'qualifies',$1,$2)",[groupApprovalFrom,cutoff]);
    const decision=decisionFixture(h.evidenceId);decision.diagnostics.rubricVersion='openai.decisions.antseed.v3';decision.lane={outcome:'propose',targetLane:'Integrations',reason:'Authored future-group pilot evidence; no live model',nextAction:null,evidenceIds:[h.evidenceId]};
    const job=randomUUID();await h.db.query("INSERT INTO analysis_jobs(id,chat_id,policy_version,mapping_version,dedupe_key,status,decision) SELECT $1::uuid,id,policy_version,mapping_version,($1::uuid)::text,'completed',$2 FROM chats WHERE id=-1001",[job,JSON.stringify(decision)]);
    await h.db.transaction(tx=>h.proposals.recordAnalysisDecisionTx(tx,{jobId:job,ticketId:h.ticket.id,expectedStageVersion:0,decision}));
    const initial=(await h.db.query('SELECT id FROM proposals WHERE id<>$1',[h.proposal.id])).rows[0]!.id;
    const ticket=(await h.projector.project(h.ticket.id))!;
    expect(await h.proposals.placeInitialAutomatically()).toBe(0);expect(await h.service.applyNext()).toBeNull();
    expect((await h.adapter.getTask(ticket.vikunjaTaskId!))!.bucketId).toBe(h.board.buckets['To be started']);
    let sends=0;const bus=new DurableControlBus(h.db,{status:async()=>({state:'ready'}),sendControlMessage:async()=>{sends++;return {messageId:50};}} as unknown as TelegramPort);
    await bus.tick();await bus.tick();expect(sends).toBe(1);expect((await h.db.query('SELECT state FROM control_outbox WHERE proposal_id=$1',[initial])).rows[0]).toEqual({state:'sent'});
    expect((await h.db.query('SELECT 1 FROM proposal_decisions WHERE proposal_id=$1',[initial])).rowCount).toBe(0);
    await h.proposals.handleControlReply({chatId:'-2001',messageId:51,senderId:'99',replyToMessageId:50,text:'approve',sentAt:h.clock.now().toISOString()});
    await h.service.applyNext();expect((await h.adapter.getTask(ticket.vikunjaTaskId!))!.bucketId).toBe(h.board.buckets.Integrations);
    expect(await h.records.getTicket(ticket.id)).toMatchObject({lane:'Integrations',stageVersion:1});
    expect((await h.db.query('SELECT source FROM proposal_decisions WHERE proposal_id=$1',[initial])).rows[0]).toEqual({source:'telegram'});
    const evidence=randomUUID();await h.db.query("INSERT INTO messages(chat_id,id,sent_at,text) VALUES(-1001,999,now(),'Fresh later update')");
    await h.db.query("INSERT INTO evidence(id,chat_id,message_id,message_version,excerpt,observed_at) VALUES($1,-1001,999,1,'Fresh later update',now())",[evidence]);
    decision.lane={outcome:'propose',targetLane:'Completed',reason:'Authored later update',nextAction:null,evidenceIds:[evidence]};
    await h.db.transaction(tx=>h.proposals.recordAnalysisDecisionTx(tx,{jobId:randomUUID(),ticketId:ticket.id,expectedStageVersion:1,decision}));
    expect(await h.proposals.placeInitialAutomatically()).toBe(0);expect(await h.service.applyNext()).toBeNull();
    expect((await h.db.query("SELECT 1 FROM proposals p JOIN control_outbox o ON o.proposal_id=p.id WHERE p.decision='pending' AND p.target_lane='Completed'")).rowCount).toBe(1);
    expect((await h.adapter.getTask(ticket.vikunjaTaskId!))!.bucketId).toBe(h.board.buckets.Integrations);
  },30000);
  it('requires future-group intake approval before importing or creating its first card on real PostgreSQL',async()=>{
    const h=await fixture();await h.configureControl();const store=new TelegramStore(h.db,{apiId:null,apiHash:null,sessionPath:':memory:',historyBatchSize:20,historyMaxBatches:1});
    const cutoff='2026-10-04T18:30:00Z',groupApprovalFrom='2026-10-23T13:48:42.677Z';
    await h.db.query("INSERT INTO app_settings(key,value) VALUES('telegram:automatic-since',$1)",[JSON.stringify({enabled:true,revision:'future-intake-native',cutoff,initialPlacement:true,groupApprovalFrom})]);
    await h.db.query("INSERT INTO telegram_conversation_starts(chat_id,state,first_message_at,checked_cutoff) VALUES(-1001,'older','2020-01-01',$1)",[cutoff]);
    await store.upsertDialog({id:'-42',kind:'supergroup',title:'AntSeed <> New synthetic group',username:null,archived:false,latestMessageAt:groupApprovalFrom});
    const worker=new AutomaticIntake(h.db,store,{async conversationStart(){return {at:groupApprovalFrom,messageId:1,uncertain:false,reason:'creation_service_message'};}});await worker.tick();
    expect((await h.db.query('SELECT inclusion FROM chats WHERE id=-42')).rows[0]).toEqual({inclusion:'undecided'});
    expect((await h.db.query('SELECT 1 FROM messages WHERE chat_id=-42')).rowCount).toBe(0);expect((await h.db.query('SELECT 1 FROM tickets WHERE chat_id=-42')).rowCount).toBe(0);
    let sends=0;const telegram={status:async()=>({state:'ready'}),sendControlMessage:async()=>{sends++;return {messageId:50};}} as unknown as TelegramPort;
    const bus=new DurableControlBus(h.db,telegram,store);await bus.tick();expect(sends).toBe(1);
    const {ChatIntake}=await import('../../src/telegram/intake.js');const intake=new ChatIntake(h.db,store,telegram);
    const reply={chatId:'-2001',messageId:51,senderId:'99',replyToMessageId:50,text:'approve',sentAt:h.clock.now().toISOString()};await intake.handle(reply);await intake.handle(reply);
    expect((await h.db.query('SELECT inclusion FROM chats WHERE id=-42')).rows[0]).toEqual({inclusion:'included'});
    expect((await h.db.query('SELECT lane,stage_version FROM tickets WHERE chat_id=-42')).rows).toEqual([{lane:'To be started',stage_version:0}]);
  },30000);
  it('serializes two real PostgreSQL scan workers, admitting a qualifying conversation once',async()=>{
    const h=await fixture(),store=new TelegramStore(h.db,{apiId:null,apiHash:null,sessionPath:':memory:',historyBatchSize:20,historyMaxBatches:1});
    const cutoff='2026-10-04T18:30:00Z';await h.db.query("INSERT INTO app_settings(key,value) VALUES('telegram:automatic-since',$1)",[JSON.stringify({enabled:true,revision:'native-scan',cutoff,initialPlacement:true})]);
    await store.upsertDialog({id:'7',kind:'user',title:'Synthetic new conversation',username:null,archived:false,latestMessageAt:'2026-10-22T00:00:00Z'});
    // Keep the pre-existing fixture conversation out of this probe's candidate set.
    await h.db.query("INSERT INTO telegram_conversation_starts(chat_id,state,first_message_at,checked_cutoff) VALUES(-1001,'older','2020-01-01',$1)",[cutoff]);
    let calls=0;const reader={async conversationStart(){calls++;await delay(50);return {at:'2026-10-05T01:00:00Z',messageId:1,uncertain:false,reason:'first_available_message'};}};
    const a=new AutomaticIntake(h.db,store,reader),b=new AutomaticIntake(h.db,store,reader);await Promise.all([a.tick(),b.tick()]);expect(calls).toBe(1);
    expect((await h.db.query('SELECT state FROM telegram_conversation_starts WHERE chat_id=7')).rows[0]).toEqual({state:'qualifies'});expect((await h.db.query('SELECT count(*)::int n FROM tickets WHERE chat_id=7')).rows[0]!.n).toBe(1);
    expect((await h.db.query('SELECT 1 FROM messages WHERE chat_id=7')).rowCount).toBe(0);
  },30000);
  it('projects full context initially To be started and serializes eight concurrent applies', async () => {
    const h = await fixture(); const ticket = await h.projector.project(h.ticket.id); const remote = await h.adapter.getTask(ticket!.vikunjaTaskId!);
    expect(remote!.bucketId).toBe(h.board.buckets['To be started']); expect(remote!.description).toContain('Mira'); expect(remote!.description).toContain('2026-10-18'); expect(remote!.description).toContain(h.evidenceId);
    // Lost local projection bookkeeping/restart must tolerate an actual PATCH304 no-op.
    await h.db.query("DELETE FROM app_settings WHERE key=$1", [`workflow:projection:${h.ticket.id}`]); await h.projector.project(h.ticket.id);
    const results = await Promise.all(Array.from({ length: 8 }, () => h.service.applyNext())); expect(results.some((r) => r?.state === 'committed')).toBe(true);
    expect(await h.records.getTicket(h.ticket.id)).toMatchObject({ lane: 'Integrations', stageVersion: 1 });
    expect((await h.adapter.getTask(ticket!.vikunjaTaskId!))!.bucketId).toBe(h.board.buckets.Integrations);
  }, 30000);
  it.each(['prepared', 'accepted', 'confirmed'])('reconciles actual crash window %s with one logical stage increment', async (phase) => {
    const h = await fixture(); await h.projector.project(h.ticket.id); let id = '';
    await h.mutations.withOwnedTicket(h.ticket.id, async () => {
      const m = await h.mutations.prepare(h.proposal.id); id = m.id;
      if (phase !== 'prepared') await h.adapter.moveTask({ taskId: m.taskId, projectId: h.board.projectId, viewId: h.board.viewId, targetBucketId: m.targetBucketId });
      if (phase === 'confirmed') await h.mutations.confirmRemote(id, m.targetBucketId);
    });
    expect((await h.service.reconcile(id)).state).toBe('committed'); await h.service.reconcile(id);
    expect(await h.records.getTicket(h.ticket.id)).toMatchObject({ lane: 'Integrations', stageVersion: 1 });
  }, 20000);
  it('recovers an actual accepted move whose response is lost', async () => {
    const h = await fixture(); let calls = 0;
    const original = h.adapter.moveTask.bind(h.adapter); h.adapter.moveTask = async (input) => { calls++; await original(input); throw new Error('Synthetic response lost after actual acceptance'); };
    const unknown = await h.service.applyNext(); expect(unknown!.state).toBe('remote_unknown');
    expect((await h.service.reconcile(unknown!.id)).state).toBe('committed'); expect(calls).toBe(1); expect((await h.records.getTicket(h.ticket.id)).stageVersion).toBe(1);
  }, 20000);
  it('loses a real checked-out session after remote acceptance, fences old callbacks, then reconciles freshly', async () => {
    const h = await fixture(); await h.projector.project(h.ticket.id); const entered = deferred(), resume = deferred(), finished = deferred(); let id = '', pid = 0; let failures = 0;
    const dying = h.mutations.withOwnedTicket(h.ticket.id, async () => {
      const m = await h.mutations.prepare(h.proposal.id); id = m.id;
      pid = Number((await h.db.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
      await h.adapter.moveTask({ taskId: m.taskId, projectId: h.board.projectId, viewId: h.board.viewId, targetBucketId: m.targetBucketId }); entered.resolve(); await resume.promise;
      for (const operation of [() => h.mutations.markRemoteUnknown(id, 'private'), () => h.mutations.confirmRemote(id, m.targetBucketId), () => h.mutations.commit(id), () => h.db.query('SELECT 1'), () => h.db.withSessionLock('other', async () => {})]) {
        try { await operation(); } catch { failures++; }
      }
      finished.resolve();
    });
    const rejected = expect(dying).rejects.toMatchObject({ code: 'upstream_unavailable' }); await entered.promise;
    await admin.query('SELECT pg_terminate_backend($1)', [pid]); await rejected;
    expect((await h.service.reconcile(id)).state).toBe('committed'); const fresh = (await h.db.query('SELECT * FROM mutations WHERE id=$1', [id])).rows[0];
    resume.resolve(); await finished.promise; expect(failures).toBe(5); expect((await h.db.query('SELECT * FROM mutations WHERE id=$1', [id])).rows[0]).toEqual(fresh);
    expect((await h.records.getTicket(h.ticket.id)).stageVersion).toBe(1);
  }, 30000);
  it('real SQL CAS rejects expiry and old callbacks after fresh same-worker adoption', async () => {
    const h = await fixture(); await h.projector.project(h.ticket.id); let id = '', old = ''; let late!: () => Promise<void>;
    await h.mutations.withOwnedTicket(h.ticket.id, async () => {
      const m = await h.mutations.prepare(h.proposal.id); id = m.id; await h.mutations.claim({ workerId: 'same', leaseMs: 10 });
      old = String((await h.db.query('SELECT worker_id FROM mutations WHERE id=$1', [id])).rows[0]!.worker_id);
      late = AsyncResource.bind(async () => { for (const action of [() => h.mutations.markRemoteUnknown(id, ''), () => h.mutations.confirmRemote(id, m.targetBucketId), () => h.mutations.commit(id)]) await expect(action()).rejects.toThrow(); });
      h.advance(11); await expect(h.mutations.markRemoteUnknown(id, '')).rejects.toMatchObject({ code: 'conflict' });
    });
    await h.mutations.withOwnedTicket(h.ticket.id, async () => { await h.mutations.prepare(h.proposal.id); await h.mutations.claim({ workerId: 'same', leaseMs: 60000 }); });
    const fresh = (await h.db.query('SELECT * FROM mutations WHERE id=$1', [id])).rows[0]!; expect(fresh.worker_id).not.toBe(old); await late();
    expect((await h.db.query('SELECT * FROM mutations WHERE id=$1', [id])).rows[0]).toEqual(fresh);
  }, 20000);
  it('schedules only after migrations and aborts/awaits a held projection during shutdown', async () => {
    const h = await fixture(); await h.projector.project(h.ticket.id);
    const entered = deferred(), release = deferred(); const original = h.adapter.getTask.bind(h.adapter); let held = false;
    h.adapter.getTask = async (id) => { if (!held) { held = true; entered.resolve(); await release.promise; } return original(id); };
    function unavailable<T extends object>(): T { return new Proxy({} as T, { get() { throw new Error('Unrelated platform service'); } }); }
    const platform = { telegram: unavailable<PlatformServices['telegram']>(), chats: unavailable<PlatformServices['chats']>(), ingestion: unavailable<PlatformServices['ingestion']>(), config: { ...config, jev: { ...config.jev, apiKey: 'synthetic-blocked-key' } }, clock: h.clock, db: h.db, control: h.control, vikunja: h.adapter } as PlatformServices;
    const module = await createWorkflowModule(platform), app = Fastify();
    try {
      await module.register(app); expect(h.handlers.size).toBe(1); await module.start(); await entered.promise;
      let stopped = false; const stopping = module.stop().then(() => { stopped = true; }); await delay(10); expect(stopped).toBe(false);
      release.resolve(); await stopping; expect(h.handlers.size).toBe(0); expect((await h.records.getTicket(h.ticket.id)).stageVersion).toBe(0);
      expect((await h.db.query("SELECT value FROM app_settings WHERE key='workflow:jev:breaker'")).rows[0]!.value).toMatchObject({ paused: true, code: 'entitlement' });
    } finally { release.resolve(); await module.stop(); await app.close(); }
  }, 20000);
  it('replays the real control inbox after decision commit without duplicate approval or a lane move', async () => {
    const h = await fixture(); await h.configureControl(); let sends = 0;
    const telegram: TelegramPort = new Proxy({} as TelegramPort, { get(_target, key) {
      if (key === 'status') return async () => ({ state: 'ready', code: null, detail: 'Synthetic Telegram transport only', checkedAt: h.clock.now().toISOString() });
      if (key === 'sendControlMessage') return async () => { sends++; return { messageId: 50 }; };
      throw new Error('Unexpected Telegram I/O in control integration');
    } });
    const control = new DurableControlBus(h.db, telegram), proposals = new ProposalRepository(h.db, control, h.clock);
    const pending = await proposals.propose({ idempotencyKey: 'control-integration', ticketId: h.ticket.id, expectedStageVersion: 0, targetLane: 'Blocked', reason: 'Synthetic dependency', nextAction: null, evidenceIds: [h.evidenceId], origin: 'manual' });
    function unused<T extends object>(): T { return new Proxy({} as T, { get() { throw new Error('Unrelated service'); } }); }
    const platform: PlatformServices = { db: h.db, clock: h.clock, config, vikunja: h.adapter, control, telegram, chats: unused(), ingestion: unused() };
    const module = await createWorkflowModule(platform), app = Fastify(); let once = true;
    await module.register(app); const unsubscribe = control.subscribe(async () => { if (once) { once = false; throw new Error('Synthetic crash after workflow decision committed'); } });
    try {
      await control.tick(); expect(sends).toBe(1);
      await h.db.query('INSERT INTO control_inbox(chat_id,message_id,sender_id,reply_to_id,text,sent_at) VALUES(-2001,51,99,50,$1,now())', ['approve']);
      await control.tick(); expect((await proposals.get(pending.id)).decision).toBe('approved');
      expect((await h.db.query('SELECT state FROM control_inbox WHERE message_id=51')).rows[0]!.state).toBe('pending');
      await h.db.query('UPDATE control_inbox SET lease_until=NULL WHERE message_id=51'); await control.tick();
      expect((await h.db.query('SELECT state FROM control_inbox WHERE message_id=51')).rows[0]!.state).toBe('done');
      expect((await h.db.query('SELECT * FROM proposal_decisions WHERE proposal_id=$1', [pending.id])).rows).toHaveLength(1);
      expect((await h.records.getTicket(h.ticket.id)).stageVersion).toBe(0); expect(sends).toBe(1);
    } finally { unsubscribe(); await module.stop(); await app.close(); }
  }, 20000);
  it('reads back and reflects an actual accepted move after policy exclusion', async () => {
    const h = await fixture(); let calls = 0; const original = h.adapter.moveTask.bind(h.adapter);
    h.adapter.moveTask = async (input) => { calls++; await original(input); throw new Error('Synthetic lost response after acceptance'); };
    const unknown = (await h.service.applyNext())!;
    await h.db.query("UPDATE chats SET inclusion='excluded',policy_version=policy_version+1 WHERE id=-1001"); await h.db.query("UPDATE tickets SET tracking_state='suspended'"); await h.db.query("UPDATE proposals SET apply_state='stale'");
    let reads = 0; const read = h.adapter.getTask.bind(h.adapter); h.adapter.getTask = async (id) => { reads++; return read(id); };
    expect((await h.service.reconcile(unknown.id)).state).toBe('conflict'); expect(reads).toBeGreaterThan(0); expect(calls).toBe(1);
    expect(await h.records.getTicket(h.ticket.id)).toMatchObject({ lane: 'Integrations', stageVersion: 1, trackingState: 'suspended' });
  }, 20000);
  it('serializes real operator exclusion with remote observation using the source chat lock first', async () => {
    const h = await fixture(); const ticket = (await h.projector.project(h.ticket.id))!;
    await h.adapter.moveTask({ taskId: ticket.vikunjaTaskId!, projectId: h.board.projectId, viewId: h.board.viewId, targetBucketId: h.board.buckets.Completed });
    const entered = deferred(), release = deferred(); let paused = false;
    const observed: Database = { query: h.db.query.bind(h.db), withSessionLock: h.db.withSessionLock.bind(h.db), close: async () => {},
      transaction: (work) => h.db.transaction((tx) => { const guarded: SqlExecutor = { async query<R extends QueryResultRow>(sql: string, values?: unknown[]) {
        const result = await tx.query<R>(sql, values); if (!paused && sql.startsWith('UPDATE tickets SET previous_active_lane=')) { paused = true; entered.resolve(); await release.promise; } return result;
      } }; return work(guarded); }) };
    const projecting = new TicketProjector(observed, h.adapter, new RecordsRepository(observed, h.clock), h.clock).project(h.ticket.id).then(() => null, (error: unknown) => error);
    await entered.promise;
    const excluding = new TelegramStore(h.db, config.telegram).setInclusion({ idempotencyKey: 'exclusion-race', chatId: '-1001', inclusion: 'excluded', expectedPolicyVersion: 0 });
    const exclusionResult = excluding.then((chat) => ({ chat }), (error: unknown) => ({ error }));
    let waiting = false;
    try { for (let i = 0; i < 100; i++) {
      const rows = (await admin.query("SELECT query FROM pg_stat_activity WHERE wait_event_type='Lock' AND application_name='antseed-kanban' AND query LIKE '%FROM chats WHERE id=%FOR UPDATE%'")).rows;
      if (rows.length) { waiting = true; break; } await delay(10);
    } } finally { release.resolve(); }
    expect(waiting).toBe(true); const exclusion = await exclusionResult; expect(exclusion).toMatchObject({ chat: { inclusion: 'excluded', policyVersion: 1 } });
    const projection = await projecting; if (projection) expect(projection).toMatchObject({ code: 'conflict' });
    expect((await h.records.getTicket(h.ticket.id)).trackingState).toBe('suspended');
  }, 20000);
  it('retains an early approval until accepted-send lost-response receipt linkage is repaired', async () => {
    const h = await fixture(); await h.configureControl(); let sends = 0, receipts = 0, text = '';
    const telegram: TelegramPort = new Proxy({} as TelegramPort, { get(_target, key) {
      if (key === 'status') return async () => ({ state: 'ready', code: null, detail: 'Synthetic Telegram transport', checkedAt: h.clock.now().toISOString() });
      if (key === 'authorizedSelf') return async () => '99';
      if (key === 'sendControlMessage') return async (input: { text: string }) => { sends++; text = input.text; throw new Error('Synthetic accepted send50 then lost response'); };
      if (key === 'getHistory') return async () => { receipts++; return { messages: [{ ...inputFixture().messages[0]!, chatId: '-2001', id: 50, senderId: '99', text }], next: null, complete: true }; };
      throw new Error('Unexpected Telegram I/O');
    } });
    const bus = new DurableControlBus(h.db, telegram), repository = new ProposalRepository(h.db, bus, h.clock);
    const pending = await repository.propose({ idempotencyKey: 'early-reply', ticketId: h.ticket.id, expectedStageVersion: 0, targetLane: 'Blocked', reason: 'Synthetic dependency', nextAction: null, evidenceIds: [h.evidenceId], origin: 'manual' });
    const unsubscribe = bus.subscribe((message) => repository.handleControlReply(message));
    try {
      await bus.tick(); expect((await h.db.query('SELECT state,message_id FROM control_outbox WHERE proposal_id=$1', [pending.id])).rows[0]).toMatchObject({ state: 'failed', message_id: null });
      await repository.handleControlReply({ chatId: '-2001', messageId: 54, replyToMessageId: 50, senderId: '99', text: 'unrelated text while delivery unknown', sentAt: h.clock.now().toISOString() });
      await h.db.query('INSERT INTO control_inbox(chat_id,message_id,sender_id,reply_to_id,text,sent_at) VALUES(-2001,51,99,50,$1,now())', ['approve']);
      await h.db.query('UPDATE control_outbox SET lease_until=NULL WHERE proposal_id=$1', [pending.id]); await bus.tick();
      expect((await h.db.query('SELECT state FROM control_inbox WHERE message_id=51')).rows[0]!.state).toBe('pending'); expect((await repository.get(pending.id)).decision).toBe('pending');
      expect((await h.db.query('SELECT state,message_id FROM control_outbox WHERE proposal_id=$1', [pending.id])).rows[0]).toMatchObject({ state: 'sent', message_id: 50 });
      await h.db.query('UPDATE control_inbox SET lease_until=NULL WHERE message_id=51'); await bus.tick();
      expect((await h.db.query('SELECT state FROM control_inbox WHERE message_id=51')).rows[0]!.state).toBe('done'); expect((await repository.get(pending.id)).decision).toBe('approved');
      expect((await h.db.query('SELECT * FROM proposal_decisions WHERE proposal_id=$1', [pending.id])).rows).toHaveLength(1); expect(sends).toBe(1); expect(receipts).toBe(1);
      await repository.handleControlReply({ chatId: '-2001', messageId: 52, replyToMessageId: 999, senderId: '99', text: 'approve', sentAt: h.clock.now().toISOString() });
      await repository.handleControlReply({ chatId: '-2001', messageId: 53, replyToMessageId: 50, senderId: '99', text: 'unrelated text', sentAt: h.clock.now().toISOString() });
      await repository.handleControlReply({ chatId: '-2001', messageId: 55, replyToMessageId: 50, senderId: '99', text: 'correct invalid lane', sentAt: h.clock.now().toISOString() });
      expect((await h.db.query("SELECT value FROM app_settings WHERE key='workflow:control:-2001:55'")).rows[0]!.value).toMatchObject({ code: 'validation' });
      expect((await h.records.getTicket(h.ticket.id)).stageVersion).toBe(0);
    } finally { unsubscribe(); }
  }, 20000);
  it('records an observed target conservatively when policy changes after the real remote move', async () => {
    const h = await fixture(); const original = h.adapter.moveTask.bind(h.adapter);
    h.adapter.moveTask = async (input) => { await original(input); await admin.query(`UPDATE ${h.schema}.chats SET policy_version=policy_version+1 WHERE id=-1001`); };
    const result = await h.service.applyNext(); expect(result!.state).toBe('conflict'); expect((await h.service.get(h.proposal.id)).applyState).toBe('stale');
    expect(await h.records.getTicket(h.ticket.id)).toMatchObject({ lane: 'Integrations', stageVersion: 1 });
  }, 20000);
});
