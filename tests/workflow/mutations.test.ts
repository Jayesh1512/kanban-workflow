import { AsyncResource } from 'node:async_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { workflowHarness } from './harness.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((close) => close())); });
async function setup() { const h = await workflowHarness(); cleanups.push(() => h.db.close()); const p = await h.propose(); await h.service.decide({ idempotencyKey: 'approve', proposalId: p.id, decision: 'approve' }); return { ...h, proposal: p }; }

describe('deterministic mutation scheduling model (real PG proof separate)', () => {
  it('projects the initial lane and applies once under concurrent workers', async () => {
    const h = await setup(); await h.projector.project(h.ticket.id);
    expect([...h.tasks.values()][0]!.bucketId).toBe('1'); expect((await h.records.getTicket(h.ticket.id)).lane).toBe('To be started');
    await Promise.all([h.service.applyNext(), h.service.applyNext()]);
    expect(h.moves()).toBe(1); expect(await h.records.getTicket(h.ticket.id)).toMatchObject({ lane: 'Integrations', stageVersion: 1 });
    expect((await h.service.get(h.proposal.id)).applyState).toBe('applied'); expect(await h.service.applyNext()).toBeNull();
  });
  it('recovers an accepted remote move with a lost response without moving twice', async () => {
    const h = await setup(); h.failMoveResponseOnce(); const unknown = await h.service.applyNext(); expect(unknown!.state).toBe('remote_unknown');
    expect((await h.records.getTicket(h.ticket.id)).stageVersion).toBe(0);
    expect((await h.service.reconcile(unknown!.id)).state).toBe('committed'); expect(h.moves()).toBe(1);
    expect((await h.records.getTicket(h.ticket.id)).stageVersion).toBe(1);
    await h.service.reconcile(unknown!.id); expect((await h.records.getTicket(h.ticket.id)).stageVersion).toBe(1);
  });
  it('recovers remote confirmation followed by a local crash with one stage increment', async () => {
    const h = await setup(); await h.projector.project(h.ticket.id); let id = '';
    await h.mutations.withOwnedTicket(h.ticket.id, async () => {
      const mutation = await h.mutations.prepare(h.proposal.id); id = mutation.id;
      await h.vikunja.moveTask({ taskId: mutation.taskId, projectId: '1', viewId: '1', targetBucketId: mutation.targetBucketId });
      await h.mutations.confirmRemote(id, mutation.targetBucketId);
      // Process ends before local commit. A fresh scope must read the remote target.
    });
    expect((await h.service.reconcile(id)).state).toBe('committed'); expect(h.moves()).toBe(1); expect((await h.records.getTicket(h.ticket.id)).stageVersion).toBe(1);
  });
  it('reflects an external conflicting lane without overwriting it', async () => {
    const h = await setup(); await h.projector.project(h.ticket.id); let id = '';
    await h.mutations.withOwnedTicket(h.ticket.id, async () => { id = (await h.mutations.prepare(h.proposal.id)).id; });
    [...h.tasks.values()][0]!.bucketId = '6';
    expect((await h.service.reconcile(id)).state).toBe('conflict'); expect(h.moves()).toBe(0);
    expect((await h.records.getTicket(h.ticket.id)).stageVersion).toBe(1); expect((await h.service.get(h.proposal.id)).applyState).toBe('stale');
  });
  it('rejects every mutation write outside a matching ownership scope', async () => {
    const h = await setup(); await h.projector.project(h.ticket.id); let id = '';
    await h.mutations.withOwnedTicket(h.ticket.id, async () => { id = (await h.mutations.prepare(h.proposal.id)).id; });
    for (const write of [() => h.mutations.prepare(h.proposal.id), () => h.mutations.claim({ workerId: 'same', leaseMs: 60000 }), () => h.mutations.markRemoteUnknown(id, 'raw private detail'), () => h.mutations.confirmRemote(id, '3'), () => h.mutations.commit(id)]) await expect(write()).rejects.toThrow();
    expect((await h.db.query('SELECT state FROM mutations WHERE id=$1', [id])).rows[0]!.state).toBe('prepared');
  });
  it('fences expired original callbacks across fresh claims with the same worker identity', async () => {
    const h = await setup(); await h.projector.project(h.ticket.id); let id = ''; let late!: () => Promise<void>; let token = '';
    await h.mutations.withOwnedTicket(h.ticket.id, async () => {
      id = (await h.mutations.prepare(h.proposal.id)).id; await h.mutations.claim({ workerId: 'same', leaseMs: 10 }); token = String((await h.db.query('SELECT worker_id FROM mutations WHERE id=$1', [id])).rows[0]!.worker_id);
      late = AsyncResource.bind(async () => { for (const write of [() => h.mutations.markRemoteUnknown(id, ''), () => h.mutations.confirmRemote(id, '3'), () => h.mutations.commit(id)]) await expect(write()).rejects.toThrow(); });
      h.advance(11); await expect(h.mutations.markRemoteUnknown(id, '')).rejects.toThrow();
    });
    await h.mutations.withOwnedTicket(h.ticket.id, async () => { await h.mutations.prepare(h.proposal.id); await h.mutations.claim({ workerId: 'same', leaseMs: 60000 }); });
    const fresh = (await h.db.query('SELECT worker_id,state,attempts FROM mutations WHERE id=$1', [id])).rows[0]!; expect(fresh.worker_id).not.toBe(token);
    await late(); expect((await h.db.query('SELECT worker_id,state,attempts FROM mutations WHERE id=$1', [id])).rows[0]).toEqual(fresh);
  });
  it('never reenters SQL after a simulated session loss; a fresh caller reconciles', async () => {
    const h = await setup(); await h.projector.project(h.ticket.id); let id = ''; let late!: () => Promise<void>;
    await expect(h.mutations.withOwnedTicket(h.ticket.id, async () => {
      const mutation = await h.mutations.prepare(h.proposal.id); id = mutation.id;
      await h.vikunja.moveTask({ taskId: mutation.taskId, projectId: '1', viewId: '1', targetBucketId: mutation.targetBucketId });
      late = AsyncResource.bind(async () => { await expect(h.mutations.markRemoteUnknown(id, '')).rejects.toThrow(); await expect(h.db.query('SELECT 1')).rejects.toThrow(); await expect(h.db.withSessionLock('other', async () => {})).rejects.toThrow(); });
      h.disconnect(); await h.mutations.confirmRemote(id, mutation.targetBucketId);
    })).rejects.toThrow();
    await late(); expect((await h.service.reconcile(id)).state).toBe('committed'); expect(h.moves()).toBe(1);
  });
});

it('releases a stale prepared journal without applying obsolete evidence', async () => {
  const h = await setup(); await h.projector.project(h.ticket.id); let id = '';
  await h.mutations.withOwnedTicket(h.ticket.id, async () => { id = (await h.mutations.prepare(h.proposal.id)).id; });
  await h.db.query('UPDATE chats SET policy_version=policy_version+1 WHERE id=-1001');
  await h.service.applyNext(); expect((await h.db.query('SELECT state FROM mutations WHERE id=$1', [id])).rows[0]!.state).toBe('conflict'); expect(h.moves()).toBe(0);
});
it('does not redo a confirmed move that an external operator subsequently reversed', async () => {
  const h = await setup(); await h.projector.project(h.ticket.id); let id = '';
  await h.mutations.withOwnedTicket(h.ticket.id, async () => { const m = await h.mutations.prepare(h.proposal.id); id = m.id; await h.mutations.confirmRemote(id, m.targetBucketId); });
  expect((await h.service.reconcile(id)).state).toBe('conflict'); expect(h.moves()).toBe(0); expect((await h.records.getTicket(h.ticket.id)).lane).toBe('To be started');
});

it('does not let terminal stale/no-journal proposals starve a later current approval', async () => {
  const h = await setup(); await h.db.query("UPDATE proposals SET apply_state='stale' WHERE id=$1", [h.proposal.id]);
  const { randomUUID } = await import('node:crypto'); const id = randomUUID();
  await h.db.query("INSERT INTO messages(chat_id,id,sent_at,text) VALUES(-1001,2,now(),'Synthetic fresh supported evidence')");
  await h.db.query("INSERT INTO evidence(id,chat_id,message_id,message_version,excerpt,observed_at) VALUES($1,-1001,2,1,'Synthetic fresh supported evidence',now())", [id]);
  const newer = await h.service.propose({ idempotencyKey: 'new-current', ticketId: h.ticket.id, expectedStageVersion: 0, targetLane: 'Work in progress', reason: 'Synthetic current source', nextAction: null, evidenceIds: [id], origin: 'manual' });
  await h.service.decide({ idempotencyKey: 'new-approve', proposalId: newer.id, decision: 'approve' });
  expect((await h.service.applyNext())!.state).toBe('committed'); expect(h.moves()).toBe(1); expect((await h.service.get(newer.id)).applyState).toBe('applied');
});
it('reads back an unknown accepted effect even after exclusion and reflects it conservatively', async () => {
  const h = await setup(); h.failMoveResponseOnce(); const unknown = (await h.service.applyNext())!;
  await h.db.query("UPDATE chats SET inclusion='excluded',policy_version=policy_version+1 WHERE id=-1001"); await h.db.query("UPDATE tickets SET tracking_state='suspended'"); await h.db.query("UPDATE proposals SET apply_state='stale'");
  let reads = 0; const original = h.vikunja.getTask.bind(h.vikunja); h.vikunja.getTask = async (id) => { reads++; return original(id); };
  expect((await h.service.reconcile(unknown.id)).state).toBe('conflict'); expect(reads).toBe(1); expect(h.moves()).toBe(1);
  expect(await h.records.getTicket(h.ticket.id)).toMatchObject({ lane: 'Integrations', stageVersion: 1, trackingState: 'suspended' });
  expect((await h.service.get(h.proposal.id)).applyState).toBe('stale');
});
