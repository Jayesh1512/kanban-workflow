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

const project = process.env['WORKFLOW_TEST_PROJECT'];
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
// Explicit synthetic Docker project only. No Telegram, AI credentials or AI network calls.
describe.skipIf(!project)('M3.2 actual PostgreSQL + pinned Vikunja', () => {
  let config: RuntimeConfig, admin: PgDatabase;
  const cleanup: (() => Promise<unknown>)[] = [];
  beforeAll(async () => {
    if (!/^antseed-b-(?:m32|m4)-[a-z0-9-]+$/.test(project!)) throw new Error('Require an isolated Builder B M3.2 synthetic project');
    const args = ['compose', '-p', project!, '-f', 'compose.yaml']; const override = process.env['WORKFLOW_TEST_COMPOSE_OVERRIDE']; if (override) args.push('-f', override);
    // Capture runtime-generated test service secrets only in memory; never print them.
    const bundle = parse(execFileSync('docker', [...args, 'exec', '-T', 'vikunja', 'cat', '/run/antseed/runtime.env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    config = await loadRuntimeConfig({ ...bundle, AI_ENV_PATH: '/workflow-test-no-ai-file', DATABASE_URL: bundle['DATABASE_URL']!.replace('postgres:5432', `127.0.0.1:${process.env['WORKFLOW_TEST_PG_PORT']}`), VIKUNJA_URL: process.env['WORKFLOW_TEST_VIKUNJA_URL']! });
    // One login for this synthetic suite avoids hitting Vikunja's native login limiter
    // merely because isolated SQL schemas use separate adapter instances.
    const response = await fetch(`${config.vikunja.baseUrl}/api/v2/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: config.vikunja.username, password: config.vikunja.password }) });
    if (!response.ok) throw new Error(`Synthetic Vikunja fixture login failed HTTP ${response.status}`);
    const login = await response.json() as { token: string }; config.vikunja.apiToken = login.token;
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
