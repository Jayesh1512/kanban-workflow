import { AsyncResource } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { QueryResultRow } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import type { Database, SqlExecutor } from '../src/shared/ports.js';
import { TelegramStore } from '../src/telegram/store.js';
import { TicketProjector } from '../src/workflow/projection.js';
import { RecordsRepository } from '../src/workflow/records.js';
import { SqlMutationStore } from '../src/workflow/mutations.js';
import { api, deferred, fixture, project, type Fixture } from './qa-m32-support.js';

describe.skipIf(!project)('QA M3.2 independent durable apply fencing and recovery, actual PG/Vikunja', () => {
  let h: Fixture | undefined;
  afterEach(async () => { await h?.close(); h = undefined; });
  it('every journal write rejects outside matching scope; expired same-worker callbacks cannot mutate a newly adopted attempt', async () => {
    h = await fixture(); const p = await h.propose(); await h.approve(p.id); let id = '', oldToken = ''; let late!: () => Promise<void>;
    await expect(h.mutations.prepare(p.id)).rejects.toMatchObject({ code: 'conflict' });
    await h.mutations.withOwnedTicket(h.ticket.id, async () => {
      const m = await h!.mutations.prepare(p.id); id = m.id; await h!.mutations.claim({ workerId: 'same-external-worker', leaseMs: 50 });
      oldToken = String((await h!.db.query('SELECT worker_id FROM mutations')).rows[0]!.worker_id);
      late = AsyncResource.bind(async () => {
        for (const action of [() => h!.mutations.prepare(p.id), () => h!.mutations.claim({ workerId: 'same-external-worker', leaseMs: 60000 }), () => h!.mutations.markRemoteUnknown(id, 'late'), () => h!.mutations.confirmRemote(id, m.targetBucketId), () => h!.mutations.commit(id)]) await expect(action()).rejects.toThrow();
      });
      h!.advance(51); await expect(h!.mutations.markRemoteUnknown(id, 'expired')).rejects.toMatchObject({ code: 'conflict' });
      await expect(h!.mutations.claim({ workerId: 'same-external-worker', leaseMs: 60000 })).rejects.toMatchObject({ code: 'conflict' });
    });
    for (const action of [() => h!.mutations.markRemoteUnknown(id, ''), () => h!.mutations.confirmRemote(id, h!.board.buckets.Integrations), () => h!.mutations.commit(id)]) await expect(action()).rejects.toMatchObject({ code: 'conflict' });
    await h.mutations.withOwnedTicket(randomUUID(), async () => { await expect(h!.mutations.markRemoteUnknown(id, '')).rejects.toMatchObject({ code: 'conflict' }); });
    await h.mutations.withOwnedTicket(h.ticket.id, async () => { await h!.mutations.prepare(p.id); await h!.mutations.claim({ workerId: 'same-external-worker', leaseMs: 60000 }); });
    const adopted = (await h.db.query('SELECT * FROM mutations')).rows[0]!; expect(adopted.worker_id).not.toBe(oldToken);
    await late(); expect((await h.db.query('SELECT * FROM mutations')).rows[0]).toEqual(adopted);
    expect((await h.remote())?.bucketId).toBe(h.board.buckets['To be started']); expect((await h.local()).stageVersion).toBe(0);
    await h.service.reconcile(id); expect((await h.local()).stageVersion).toBe(1);
  });
  it('terminating the actual checked-out PG backend after remote acceptance fences all old callbacks, then a fresh owner reads back once', async () => {
    h = await fixture(); const p = await h.propose(); await h.approve(p.id);
    const entered = deferred(), resume = deferred(), finished = deferred(); let id = '', pid = 0, failures = 0;
    const dying = h.mutations.withOwnedTicket(h.ticket.id, async () => {
      const m = await h!.mutations.prepare(p.id); id = m.id; pid = Number((await h!.db.query('SELECT pg_backend_pid() pid')).rows[0]!.pid);
      await h!.adapter.moveTask({ taskId: m.taskId, projectId: h!.board.projectId, viewId: h!.board.viewId, targetBucketId: m.targetBucketId });
      entered.resolve(); await resume.promise;
      for (const action of [() => h!.mutations.markRemoteUnknown(id, ''), () => h!.mutations.confirmRemote(id, m.targetBucketId), () => h!.mutations.commit(id), () => h!.db.query('SELECT 1'), () => h!.db.withSessionLock('qa-late-reentry', async () => {})]) {
        try { await action(); } catch { failures++; }
      }
      finished.resolve();
    });
    const rejected = expect(dying).rejects.toMatchObject({ code: 'upstream_unavailable' }); await entered.promise;
    await h.peer().query('SELECT pg_terminate_backend($1)', [pid]); await rejected;
    expect((await h.remote())?.bucketId).toBe(h.board.buckets.Integrations);
    expect((await h.service.reconcile(id)).state).toBe('committed'); const fresh = (await h.db.query('SELECT * FROM mutations')).rows[0];
    resume.resolve(); await finished.promise; expect(failures).toBe(5); expect((await h.db.query('SELECT * FROM mutations')).rows[0]).toEqual(fresh);
    expect(await h.local()).toMatchObject({ lane: 'Integrations', stageVersion: 1 });
  }, 20000);
  it.each(['source', 'target', 'third'] as const)('excluded journal at remote %s is read back without any new stage write', async (position) => {
    h = await fixture(); const p = await h.propose(); await h.approve(p.id); let id = '';
    await h.mutations.withOwnedTicket(h.ticket.id, async () => { const m = await h!.mutations.prepare(p.id); id = m.id; });
    const lane = position === 'target' ? 'Integrations' : position === 'third' ? 'Archived' : 'To be started';
    if (position !== 'source') await h.adapter.moveTask({ taskId: h.projected.vikunjaTaskId!, projectId: h.board.projectId, viewId: h.board.viewId, targetBucketId: h.board.buckets[lane] });
    await new TelegramStore(h.db, h.config.telegram).setInclusion({ chatId: h.source.chat.id, expectedPolicyVersion: 0, inclusion: 'excluded', idempotencyKey: 'qa-exclusion' });
    let moves = 0, reads = 0; const read = h.adapter.getTask.bind(h.adapter);
    h.adapter.moveTask = async () => { moves++; throw new Error('Obsolete source must never stage-write'); };
    h.adapter.getTask = async (id) => { reads++; return read(id); };
    expect((await h.service.reconcile(id)).state).toBe('conflict'); expect(reads).toBeGreaterThan(0); expect(moves).toBe(0);
    expect(await h.local()).toMatchObject({ lane, trackingState: 'suspended', stageVersion: position === 'source' ? 0 : 1 });
    await h.service.reconcile(id); expect((await h.local()).stageVersion).toBe(position === 'source' ? 0 : 1);
    expect((await h.remote())?.bucketId).toBe(h.board.buckets[lane]);
  });
  it('an oldest approved stale proposal without a journal cannot starve a later current approval', async () => {
    h = await fixture(); const old = await h.propose('Completed'); await h.approve(old.id);
    for (const lane of ['Blocked', 'To be started'] as const) { await h.adapter.moveTask({ taskId: h.projected.vikunjaTaskId!, projectId: h.board.projectId, viewId: h.board.viewId, targetBucketId: h.board.buckets[lane] }); await h.projector.project(h.ticket.id); }
    await h.db.query("UPDATE proposals SET updated_at=now()-interval '1 day' WHERE id=$1", [old.id]);
    expect((await h.service.get(old.id)).applyState).toBe('stale');
    const current = await h.propose(); await h.approve(current.id); const result = await h.service.applyNext();
    expect(result?.proposalId).toBe(current.id); expect(result?.state).toBe('committed');
    expect(await h.local()).toMatchObject({ lane: 'Integrations', stageVersion: 3 }); expect((await h.remote())?.bucketId).toBe(h.board.buckets.Integrations);
    expect((await h.db.query('SELECT * FROM mutations WHERE proposal_id=$1', [old.id])).rows).toHaveLength(0);
  });
  it('actual projection observation holds chat first; concurrent operator exclusion waits and commits without 40P01', async () => {
    h = await fixture(); await h.propose();
    await h.adapter.moveTask({ taskId: h.projected.vikunjaTaskId!, projectId: h.board.projectId, viewId: h.board.viewId, targetBucketId: h.board.buckets.Completed });
    const entered = deferred(), release = deferred(); let paused = false;
    const guarded: Database = { query: h.db.query.bind(h.db), close: async () => {}, withSessionLock: h.db.withSessionLock.bind(h.db), transaction: (work) => h!.db.transaction((tx) => {
      const observed: SqlExecutor = { async query<R extends QueryResultRow>(sql: string, values?: unknown[]) {
        const result = await tx.query<R>(sql, values);
        if (!paused && sql.startsWith('UPDATE tickets SET previous_active_lane=')) { paused = true; entered.resolve(); await release.promise; }
        return result;
      } }; return work(observed);
    }) };
    const projected = new TicketProjector(guarded, h.adapter, new RecordsRepository(guarded, h.clock), h.clock).project(h.ticket.id).then(() => null, (e: unknown) => e);
    await entered.promise; const peer = h.peer();
    let completed = false;
    const exclude = new TelegramStore(peer, h.config.telegram).setInclusion({ chatId: h.source.chat.id, inclusion: 'excluded', expectedPolicyVersion: 0, idempotencyKey: 'qa-concurrent-exclusion' }).then((r) => { completed = true; return r; });
    try {
      let locked = false;
      for (let i = 0; i < 100; i++) {
        const wait = await h.db.query("SELECT 1 FROM pg_stat_activity WHERE application_name='antseed-kanban' AND wait_event_type='Lock' AND query LIKE '%FROM chats WHERE id=%FOR UPDATE%'"); if (wait.rows.length) { locked = true; break; } await delay(10); }
      expect(locked).toBe(true); expect(completed).toBe(false);
    } finally { release.resolve(); }
    expect(await exclude).toMatchObject({ inclusion: 'excluded', policyVersion: 1 }); const outcome = await projected;
    if (outcome) expect(outcome).toMatchObject({ code: 'conflict' });
    expect(await h.local()).toMatchObject({ lane: 'Completed', stageVersion: 1, trackingState: 'suspended' }); expect((await api(`/tasks/${h.projected.vikunjaTaskId}`)).done).toBe(true);
  }, 20000);
  it('remote refusal retains unknown journal then healthy retry reads source and completes once', async () => {
    h = await fixture(); const p = await h.propose(); await h.approve(p.id); const move = h.adapter.moveTask.bind(h.adapter); let calls = 0;
    h.adapter.moveTask = async (i) => { calls++; if (calls === 1) throw new Error('Synthetic service refusal before remote write'); return move(i); };
    const unknown = (await h.service.applyNext())!; expect(unknown.state).toBe('remote_unknown'); expect((await h.remote())?.bucketId).toBe(h.board.buckets['To be started']);
    expect((await h.service.reconcile(unknown.id)).state).toBe('committed'); expect(calls).toBe(2); expect((await h.local()).stageVersion).toBe(1); expect((await h.remote())?.bucketId).toBe(h.board.buckets.Integrations);
  });
  it('independent MutationStore instance cannot use another attempt scope outside its lifetime', async () => {
    h = await fixture(); const p = await h.propose(); await h.approve(p.id); const other = new SqlMutationStore(h.peer(), h.clock); let id = '';
    await h.mutations.withOwnedTicket(h.ticket.id, async () => { id = (await h!.mutations.prepare(p.id)).id; });
    await expect(other.commit(id)).rejects.toMatchObject({ code: 'conflict' });
    expect((await h.db.query('SELECT state FROM mutations')).rows).toEqual([{ state: 'prepared' }]);
  });
});
