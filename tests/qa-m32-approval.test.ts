import { afterEach, describe, expect, it } from 'vitest';
import { LANES } from '../src/shared/domain.js';
import { ProposalRepository } from '../src/workflow/proposals.js';
import { ProposalWorkflow } from '../src/workflow/apply.js';
import { SqlMutationStore } from '../src/workflow/mutations.js';
import { TicketProjector } from '../src/workflow/projection.js';
import { RecordsRepository } from '../src/workflow/records.js';
import { DurableControlBus } from '../src/telegram/control.js';
import { SqlAnalysisQueue } from '../src/workflow/analysis.js';
import { checkpoint, decision, enqueue, provenance } from './qa-m31-support.js';
import { api, fixture, project, type Fixture } from './qa-m32-support.js';

describe.skipIf(!project)('QA M3.2 independent approval boundary, actual PG/Vikunja; synthetic Telegram', () => {
  let h: Fixture | undefined;
  afterEach(async () => { await h?.close(); h = undefined; });
  it.each(LANES.filter((l) => l !== 'To be started'))('proposal/delivery/restart cannot move %s before approval', async (lane) => {
    h = await fixture(); const p = await h.propose(lane), off = h.bus.subscribe((m) => h!.service.handleControlReply(m));
    try {
      expect(p.decision).toBe('pending'); await h.bus.tick(); expect(h.sends()).toBe(1);
      expect(await h.service.applyNext()).toBeNull();
      const peer = h.peer(); const repository = new ProposalRepository(peer, h.bus, h.clock);
      const restarted = new ProposalWorkflow(repository, new SqlMutationStore(peer, h.clock), h.adapter, new TicketProjector(peer, h.adapter, new RecordsRepository(peer, h.clock), h.clock));
      expect((await restarted.get(p.id)).decision).toBe('pending'); expect(await restarted.applyNext()).toBeNull();
      expect((await h.remote())?.bucketId).toBe(h.board.buckets['To be started']); expect((await h.local()).stageVersion).toBe(0);
      expect((await h.db.query('SELECT * FROM mutations')).rows).toHaveLength(0);
      await h.approve(p.id); expect((await h.remote())?.bucketId).toBe(h.board.buckets['To be started']);
      const results = await Promise.all(Array.from({ length: 5 }, () => h!.service.applyNext()));
      expect(results.some((r) => r?.state === 'committed')).toBe(true);
      expect(await h.local()).toMatchObject({ lane, stageVersion: 1 }); expect((await h.remote())?.bucketId).toBe(h.board.buckets[lane]);
      expect((await api(`/tasks/${h.projected.vikunjaTaskId}`)).done).toBe(lane === 'Completed');
      expect((await h.db.query('SELECT * FROM mutations')).rows).toHaveLength(1);
    } finally { off(); }
  }, 30000);
  it('reject is terminal; correction creates a separately pending proposal and requires its own approval', async () => {
    h = await fixture(); const rejected = await h.propose('Archived');
    await h.service.decide({ idempotencyKey: 'reject', proposalId: rejected.id, decision: 'reject' });
    await expect(h.approve(rejected.id)).rejects.toMatchObject({ code: 'conflict' });
    const p = await h.propose('Completed');
    const old = await h.service.decide({ idempotencyKey: 'correct', proposalId: p.id, decision: 'correct', targetLane: 'Work in progress', reason: 'Testing is still underway', evidenceIds: [h.evidenceId] });
    expect(old.proposal.decision).toBe('corrected');
    const replacement = (await h.service.list({ ticketId: h.ticket.id })).items.find((x) => x.correctionOf === p.id)!;
    expect(replacement).toMatchObject({ decision: 'pending', applyState: 'not_requested', targetLane: 'Work in progress' });
    expect(await h.service.applyNext()).toBeNull(); expect((await h.remote())?.bucketId).toBe(h.board.buckets['To be started']);
    await h.approve(replacement.id); await h.service.applyNext();
    expect(await h.local()).toMatchObject({ lane: 'Work in progress', stageVersion: 1 });
    expect((await h.remote())?.bucketId).toBe(h.board.buckets['Work in progress']);
  });
  it('durable self-account replies dedupe across replay; conflicting second action cannot change approved decision', async () => {
    h = await fixture(); const p = await h.propose(); const off = h.bus.subscribe((m) => h!.service.handleControlReply(m));
    try {
      await h.bus.tick(); await h.reply(801, 'approve'); await h.bus.tick();
      await h.db.query("UPDATE control_inbox SET state='pending',lease_until=NULL WHERE message_id=801");
      await h.bus.tick(); await h.reply(802, 'reject'); await h.bus.tick();
      expect((await h.service.get(p.id)).decision).toBe('approved');
      expect((await h.db.query('SELECT decision FROM proposal_decisions WHERE proposal_id=$1', [p.id])).rows).toEqual([{ decision: 'approve' }]);
      expect((await h.db.query('SELECT state FROM control_inbox ORDER BY message_id')).rows).toEqual([{ state: 'done' }, { state: 'done' }]);
      expect((await h.local()).stageVersion).toBe(0); expect((await h.remote())?.bucketId).toBe(h.board.buckets['To be started']);
    } finally { off(); }
  });
  it('early approval survives accepted-send/lost-receipt, restart and repaired linkage, exactly one decision/send', async () => {
    h = await fixture(); const p = await h.propose(); h.loseSend(); await h.bus.tick();
    expect((await h.db.query('SELECT state,message_id,attempts FROM control_outbox')).rows[0]).toMatchObject({ state: 'failed', message_id: null, attempts: 1 });
    await h.reply(811, 'approve'); await h.reply(812, 'ordinary unrelated text');
    // A fresh bus/repository uses the persisted journal; no subscriber or receipt state survives in the bus.
    const peer = h.peer(), bus = new DurableControlBus(peer, h.telegram), repository = new ProposalRepository(peer, bus, h.clock);
    const off = bus.subscribe((m) => repository.handleControlReply(m));
    try {
      await h.db.query('UPDATE control_outbox SET lease_until=NULL'); await bus.tick();
      expect((await h.db.query('SELECT state FROM control_inbox WHERE message_id=811')).rows[0]?.state).toBe('pending');
      expect((await repository.get(p.id)).decision).toBe('pending'); expect(h.sends()).toBe(1);
      expect((await h.db.query('SELECT state,message_id FROM control_outbox')).rows[0]).toMatchObject({ state: 'sent', message_id: 701 });
      await h.db.query('UPDATE control_inbox SET lease_until=NULL'); await bus.tick(); await bus.tick();
      expect((await repository.get(p.id)).decision).toBe('approved'); expect(h.sends()).toBe(1);
      expect((await h.db.query('SELECT * FROM proposal_decisions')).rows).toHaveLength(1);
      expect((await h.db.query('SELECT state FROM control_inbox ORDER BY message_id')).rows).toEqual([{ state: 'done' }, { state: 'done' }]);
      expect((await h.local()).stageVersion).toBe(0); expect((await h.remote())?.bucketId).toBe(h.board.buckets['To be started']);
    } finally { off(); }
  });
  it('missing control remains visibly pending, and Blocked/resume each require fresh approval', async () => {
    h = await fixture(false); const p = await h.propose('Blocked');
    expect((await h.service.get(p.id)).lastError).toBe('control_chat_missing'); expect(await h.service.applyNext()).toBeNull();
    await h.approve(p.id); await h.service.applyNext();
    expect(await h.local()).toMatchObject({ lane: 'Blocked', stageVersion: 1, previousActiveLane: 'To be started' });
    const resume = await h.propose('Work in progress'); expect(await h.service.applyNext()).toBeNull();
    expect((await h.remote())?.bucketId).toBe(h.board.buckets.Blocked);
    await h.approve(resume.id); await h.service.applyNext();
    expect(await h.local()).toMatchObject({ lane: 'Work in progress', stageVersion: 2 }); expect((await h.remote())?.bucketId).toBe(h.board.buckets['Work in progress']);
  });
  it.each(['propose', 'no_change', 'uncertain'] as const)('committed analysis %s can create only a pending proposal and never a lane mutation', async (outcome) => {
    h = await fixture(); const jobId = await enqueue(h.db, h.source.chat.id, h.source.messages[0]!.id);
    const queue = new SqlAnalysisQueue(h.db, h.clock, h.config.timezone, { onDecision: (tx, input) => h!.proposals.recordAnalysisDecisionTx(tx, input) });
    const job = (await queue.claim({ workerId: 'qa-authored-inference', leaseMs: 60000 }))!; expect(job.id).toBe(jobId);
    const saved = await checkpoint(queue, job), current = await h.local(); const inference = decision(saved.input, current.companyId);
    inference.lane = outcome === 'propose' ? { outcome, targetLane: 'Integrations', evidenceIds: saved.input.evidence.map((x) => x.id), reason: 'Synthetic sourced testing evidence', nextAction: null } : { outcome, reason: 'Synthetic no permission to move', evidenceIds: saved.input.evidence.map((x) => x.id) };
    await queue.complete(job.id, inference, provenance('vercel'), job.claimToken);
    const proposals = (await h.service.list({})).items;
    expect(proposals).toHaveLength(outcome === 'propose' ? 1 : 0);
    if (outcome === 'propose') expect(proposals[0]).toMatchObject({ origin: 'jev', decision: 'pending', applyState: 'not_requested' });
    expect(await h.service.applyNext()).toBeNull(); expect((await h.local()).stageVersion).toBe(0); expect((await h.remote())?.bucketId).toBe(h.board.buckets['To be started']);
    expect((await h.db.query('SELECT * FROM mutations')).rows).toHaveLength(0);
  });
  it.each(['edit', 'delete', 'mapping', 'policy', 'away-back'] as const)('stale %s prevents approval/apply and any remote move', async (kind) => {
    h = await fixture(); const p = await h.propose();
    if (kind === 'edit') await h.db.query('UPDATE messages SET version=version+1');
    if (kind === 'delete') await h.db.query('UPDATE messages SET deleted_at=now()');
    if (kind === 'mapping') await h.db.query('UPDATE chats SET mapping_version=mapping_version+1 WHERE NOT is_control');
    if (kind === 'policy') await h.db.query('UPDATE chats SET policy_version=policy_version+1 WHERE NOT is_control');
    if (kind === 'away-back') {
      for (const lane of ['Blocked', 'To be started'] as const) {
        await h.adapter.moveTask({ taskId: h.projected.vikunjaTaskId!, projectId: h.board.projectId, viewId: h.board.viewId, targetBucketId: h.board.buckets[lane] }); await h.projector.project(h.ticket.id);
      }
      expect((await h.local()).stageVersion).toBe(2);
    }
    await expect(h.approve(p.id)).rejects.toMatchObject({ code: 'stale_proposal' });
    expect(await h.service.applyNext()).toBeNull(); expect((await h.service.get(p.id)).applyState).toBe('stale');
    expect((await h.remote())?.bucketId).toBe(h.board.buckets['To be started']); expect((await h.db.query('SELECT * FROM mutations')).rows).toHaveLength(0);
  });
});
