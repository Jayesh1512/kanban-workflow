import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { QueryResultRow } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import type { MeetingTaskPort, MeetingRemoteTask } from '../../src/meetings/domain.js';
import { MeetingTaskPublisher } from '../../src/meetings/tasks.js';
import { VikunjaMeetingTaskAdapter } from '../../src/meetings/vikunja.js';
import { taskDatabase, taskTestUrl, seedExport } from './task-database-helper.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture() { const f = await taskDatabase(); cleanup.push(f.close); return f; }
const port = (overrides: Partial<MeetingTaskPort> = {}): MeetingTaskPort => ({ prepare: async () => {}, find: async () => [], create: async () => ({ id: '42', url: 'http://vikunja.test/tasks/42' }), ...overrides });
async function destination(mode: 'lost' | 'held') {
  const state = { posts: 0, tasks: [] as { id: number; project_id: number; description: string }[], response: null as ServerResponse | null, description: '' };
  const arrived = deferred<void>();
  const http = createServer(async (req, res) => {
    if (req.method === 'POST') {
      state.posts++; let body = ''; for await (const chunk of req) body += chunk;
      state.description = (JSON.parse(body) as { description: string }).description;
      if (mode === 'lost') { state.tasks.push({ id: 42, project_id: 7, description: state.description }); res.destroy(); }
      else state.response = res;
      arrived.resolve(); return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url!.includes('/tasks?') ? { items: state.tasks, total_pages: state.tasks.length ? 1 : 0 } : { id: 7 }));
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  cleanup.push(async () => { http.closeAllConnections(); await new Promise<void>(r => http.close(() => r())); });
  const address = http.address(); if (!address || typeof address === 'string') throw new Error();
  return { state, arrived: arrived.promise, baseUrl: `http://127.0.0.1:${address.port}`, commit() { state.tasks.push({ id: 42, project_id: 7, description: state.description }); state.response?.end(JSON.stringify({ id: 42, project_id: 7 })); } };
}
const adapter = (db: Awaited<ReturnType<typeof fixture>>['db'], baseUrl: string, timeoutMs = 100) => new VikunjaMeetingTaskAdapter(db, { baseUrl, apiToken: 'test-token', username: '', password: null, projectTitle: 'Existing', timeoutMs });
const state = async (db: Awaited<ReturnType<typeof fixture>>['db']) => (await db.query('SELECT * FROM meeting_task_exports')).rows[0]!;
const due = async (db: Awaited<ReturnType<typeof fixture>>['db']) => { await db.query("UPDATE meeting_task_exports SET next_attempt_at=now()-interval '1 minute'"); };
describe.skipIf(!taskTestUrl)('automatic meeting task publisher with real PostgreSQL sessions', () => {
  it('automatically creates a queued action once and stores immutable exact dispatch snapshot and receipt', async () => {
    const { db } = await fixture(); const seeded = await seedExport(db); let creates = 0;
    const publisher = new MeetingTaskPublisher(db, port({ create: async () => { creates++; return { id: '42', url: null }; } }));
    await publisher.tick(); await publisher.tick();
    expect(creates).toBe(1); expect((await state(db)).state).toBe('created');
    expect((await db.query('SELECT snapshot FROM meeting_remote_requests')).rows[0]!.snapshot).toEqual(seeded.snapshot);
    expect((await db.query('SELECT * FROM meeting_remote_receipts')).rows).toHaveLength(1);
    await expect(db.query("UPDATE meeting_remote_requests SET marker='changed'")).rejects.toThrow('immutable');
    await expect(db.query('DELETE FROM meeting_remote_receipts')).rejects.toThrow('immutable');
  });
  it('uses a real session lock to serialize concurrent publishers through remote I/O outside transactions', async () => {
    const { db } = await fixture(); await seedExport(db); const entered = deferred<void>(), release = deferred<void>(); let creates = 0;
    const p = port({ create: async () => { creates++; entered.resolve(); await release.promise; return { id: '42', url: null }; } });
    const a = new MeetingTaskPublisher(db, p).tick(); await entered.promise;
    // Source updates remain possible: no database transaction/row lock spans remote I/O.
    await db.query("UPDATE meeting_actions SET description='new source text'");
    const b = new MeetingTaskPublisher(db, p).tick();
    await new Promise(resolve => setTimeout(resolve, 30)); expect(creates).toBe(1);
    release.resolve(); await Promise.all([a, b]); expect(creates).toBe(1);
  });
  it('cancels a retired or version-changed source under the action lock before dispatch', async () => {
    const { db } = await fixture(); await seedExport(db); let creates = 0;
    await new MeetingTaskPublisher(db, port({ prepare: async () => { await db.query("UPDATE meeting_actions SET source_state='retired',version=version+1"); }, create: async () => { creates++; return { id: '42', url: null }; } })).tick();
    expect((await state(db)).state).toBe('canceled'); expect(creates).toBe(0); expect((await db.query('SELECT * FROM meeting_remote_requests')).rows).toHaveLength(0);
  });
  it('recovers an accepted create whose HTTP response was lost using its exact marker, without another POST', async () => {
    const { db } = await fixture(); await seedExport(db); const server = await destination('lost');
    const publisher = new MeetingTaskPublisher(db, adapter(db, server.baseUrl));
    await publisher.tick(); expect((await state(db)).state).toBe('unknown');
    await due(db); await publisher.tick(); expect((await state(db)).state).toBe('created'); expect(server.state.posts).toBe(1);
  });
  it('retains the barrier across zero-match lookup, restart, and late commit of timed-out POST A', async () => {
    const { db } = await fixture(); await seedExport(db); const server = await destination('held');
    await new MeetingTaskPublisher(db, adapter(db, server.baseUrl, 40)).tick(); await server.arrived;
    const original = await state(db); expect(original.state).toBe('unknown'); expect(original.request_id).toBeTruthy();
    await due(db); await new MeetingTaskPublisher(db, adapter(db, server.baseUrl)).tick();
    expect((await state(db)).state).toBe('unknown'); expect((await state(db)).request_id).toBe(original.request_id); expect(server.state.posts).toBe(1);
    server.commit();
    await due(db); await new MeetingTaskPublisher(db, adapter(db, server.baseUrl)).tick();
    expect((await state(db)).state).toBe('created'); expect(server.state.posts).toBe(1);
    expect((await db.query('SELECT match_count FROM meeting_task_reconciliations ORDER BY observed_at')).rows.map(r => r.match_count)).toEqual([0, 1]);
  });
  it('keeps crash-before-fetch and ambiguous errors fenced permanently after dispatch intent', async () => {
    const { db } = await fixture(); await seedExport(db); let calls = 0;
    const p = port({ create: async () => { calls++; throw new Error('process exited before fetch, or HTTP 500'); } });
    await new MeetingTaskPublisher(db, p).tick();
    for (let n = 0; n < 3; n++) { await due(db); await new MeetingTaskPublisher(db, p).tick(); }
    expect(calls).toBe(1); expect((await state(db)).state).toBe('unknown');
  });
  it('aborts a lost PostgreSQL session, preserves a late immutable receipt, and lets only the new owner finalize', async () => {
    const { db, admin } = await fixture(); await seedExport(db);
    const entered = deferred<number>(), result = deferred<MeetingRemoteTask>(), receipted = deferred<void>(); let abortSeen = false;
    const p = port({ create: async (_snapshot, _marker, signal) => {
      signal!.addEventListener('abort', () => { abortSeen = true; });
      entered.resolve(Number((await db.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid));
      return result.promise;
    } });
    const first = new MeetingTaskPublisher(db, p).tick(); const pid = await entered.promise;
    await admin.query('SELECT pg_terminate_backend($1)', [pid]); await first;
    expect(abortSeen).toBe(true); const oldOwner = (await state(db)).claim_token;
    await new MeetingTaskPublisher(db, p).tick(); expect((await state(db)).claim_token).not.toBe(oldOwner); expect((await state(db)).state).toBe('unknown');
    // Observe the immutable append directly; its old session cannot finalize the export.
    const originalQuery = db.query.bind(db);
    db.query = async <R extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]) => { const r = await originalQuery<R>(sql, values); if (sql.startsWith('INSERT INTO meeting_remote_receipts')) receipted.resolve(); return r; };
    result.resolve({ id: 'late-42', url: null }); await receipted.promise;
    expect((await state(db)).state).toBe('unknown');
    await due(db); await new MeetingTaskPublisher(db, p).tick(); expect((await state(db)).state).toBe('created'); expect((await state(db)).remote_task_id).toBe('late-42');
  });
  it('preserves created history when source retirement wins after the durable dispatch boundary', async () => {
    const { db } = await fixture(); await seedExport(db);
    await new MeetingTaskPublisher(db, port({ create: async () => {
      await db.transaction(async tx => { await tx.query('SELECT id FROM meeting_actions FOR UPDATE'); await tx.query("UPDATE meeting_actions SET source_state='retired',version=2"); });
      return { id: '42', url: null };
    } })).tick();
    expect((await state(db)).state).toBe('created'); expect((await state(db)).request_id).toBeTruthy();
  });
  it('reports duplicate exact markers as a conflict without reposting', async () => {
    const { db } = await fixture(); await seedExport(db); let calls = 0;
    const p = port({ create: async () => { calls++; throw new Error('lost'); }, find: async () => [{ id: '1', url: null }, { id: '2', url: null }] });
    const publisher = new MeetingTaskPublisher(db, p); await publisher.tick(); await due(db); await publisher.tick();
    expect(calls).toBe(1); expect((await state(db)).state).toBe('unknown'); expect((await state(db)).last_error).toContain('multiple');
  });
  it('leaves queued work untouched when no destination is configured', async () => {
    const { db } = await fixture(); await seedExport(db); await new MeetingTaskPublisher(db, null).tick(); expect((await state(db)).state).toBe('queued');
  });
});
