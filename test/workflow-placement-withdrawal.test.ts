import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { listReview } from '../src/agent/index.ts';
import { addReview } from '../src/agent/review-groups.ts';
import { bindReviewState, captureReviewSources } from '../src/agent/review-state.ts';
import { signIn } from '../src/auth/index.ts';
import { attachMessage, getBoard, getWorkflowTicket, moveCard, updateWorkflowTicket } from '../src/board/index.ts';
import { withdrawChat } from '../src/purge/index.ts';
import { workflowFixture } from './workflow-support.ts';

type Harness = Awaited<ReturnType<typeof workflowFixture>>;
function placement(h: Harness) {
  assert.ok(h.ticket);
  const row = h.db.get<{ lane_id: number; stage_id: number; stage_human_set_at: string | null }>(
    'SELECT lane_id,stage_id,stage_human_set_at FROM card WHERE id=?',
    h.ticket.card.id,
  );
  assert.ok(row);
  return row;
}
function stageSource(h: Harness) {
  assert.ok(h.ticket);
  return h.db.get<{
    card_id: number;
    field: string;
    human: number;
    source_message_ids: string;
    source_chat_ids: string;
    source_unknown: number;
  }>("SELECT * FROM workflow_field_source WHERE card_id=? AND field='stage'", h.ticket.card.id);
}
async function retainOtherChat(h: Harness) {
  assert.ok(h.ticket);
  const account = h.db.get<{ id: number }>('SELECT id FROM channel_account');
  assert.ok(account);
  h.policy.allowOtherContext = true;
  h.app.host.includeChat(h.ctx, account.id, 'other', { company: null, agreedWordingVersion: 1 });
  await h.app.host.settle();
  await h.deliver('retained');
  const retained = h.db.get<{ id: number }>("SELECT id FROM message WHERE message_key='retained'");
  assert.ok(retained);
  attachMessage(h.ctx, retained.id, h.ticket.card.id);
  return account.id;
}
function coherentBoardCard(h: Harness) {
  assert.ok(h.ticket);
  const row = placement(h);
  assert.ok(h.db.get('SELECT id FROM stage WHERE id=? AND lane_id=?', row.stage_id, row.lane_id));
  const card = getBoard(h.ctx)
    .lanes.flatMap((l) => l.cards)
    .find((c) => c.id === h.ticket?.card.id);
  assert.ok(card);
  assert.equal(card.laneId, row.lane_id);
  assert.equal(card.stageId, row.stage_id);
  return card;
}
const privateMarker = 'PRIVATE_WORKFLOW_BLOCKER_MARKER';
function physicalContains(h: Harness, marker: string) {
  return [h.path, `${h.path}-wal`, `${h.path}-shm`].filter(existsSync).some((p) => readFileSync(p).includes(marker));
}
function assertErased(h: Harness) {
  assert.ok(h.ticket);
  assert.equal(h.db.all('SELECT * FROM workflow_field_source WHERE human=0').length, 0);
  assert.doesNotMatch(JSON.stringify(h.db.all('SELECT * FROM workflow_ticket')), /PRIVATE_WORKFLOW_BLOCKER_MARKER/);
  assert.doesNotMatch(JSON.stringify(h.db.all('SELECT * FROM action_log')), /PRIVATE_WORKFLOW_BLOCKER_MARKER/);
  assert.equal(physicalContains(h, privateMarker), false);
  assert.deepEqual(h.db.all('PRAGMA foreign_key_check'), []);
  coherentBoardCard(h);
}

test('R3 F4 actual native human generic placement survives old workflow chat withdrawal and other-chat retention', {
  timeout: 10000,
}, async (t) => {
  const h = await workflowFixture(t);
  assert.ok(h.ticket);
  await h.deliver('two');
  await h.app.pipeline.drain();
  assert.equal(getWorkflowTicket(h.ctx, h.ticket.card.id).workflowStage, 'work_in_progress');
  assert.equal(stageSource(h)?.human, 0);
  const source = h.db.get<{ id: number; message_id: number }>(
    'SELECT id,message_id FROM decision ORDER BY id DESC LIMIT 1',
  );
  assert.ok(source);
  const agent = { ...h.ctx, actor: { kind: 'agent' as const } };
  // A retained pre-fix review, with real native binding and no fabricated Jev authority.
  const review = h.db.tx(() => {
    const id = addReview(
      agent,
      {
        do: 'review',
        kind: 'move',
        groupKey: `card:${h.ticket?.card.id}`,
        chatId: h.chatId,
        why: 'low_confidence',
        confidence: 1,
        proposal: {
          kind: 'move',
          cardId: h.ticket?.card.id as number,
          toStageId: h.board.stages[4]?.id as number,
          criterion: 'Synthetic legacy unsupported suggestion',
        },
      },
      [source.message_id],
      source.id,
      'Synthetic legacy review',
    );
    const sources = captureReviewSources(agent, { chatIds: [h.chatId], messageIds: [source.message_id] });
    assert.ok(sources);
    bindReviewState(agent, source.id, sources);
    return id;
  });
  assert.equal(listReview(h.ctx).find((r) => r.id === review)?.canAccept, false);
  const session = signIn(h.db, 'alice', 'synthetic-password', h.ctx.now());
  const changed = await h.app.fetch(
    new Request(`${h.config.origin}/review/${review}/change`, {
      method: 'POST',
      headers: { Cookie: `kanban_session=${session.token}`, Origin: h.config.origin },
      body: new URLSearchParams({ to: 'stage', stageId: String(h.lane.stages[1]?.id) }),
    }),
  );
  assert.equal(changed.status, 303);
  const before = placement(h),
    provenance = stageSource(h);
  assert.equal(before.lane_id, h.lane.id);
  assert.equal(before.stage_id, h.lane.stages[1]?.id);
  const accountId = await retainOtherChat(h);
  withdrawChat(h.ctx, h.app.host, accountId, h.chatId);
  const after = placement(h);
  console.log(
    JSON.stringify({ regression: 'F4', changeHTTP: changed.status, before, after, priorStageSource: provenance }),
  );
  assert.deepEqual(after, before, 'withdrawal must preserve the later explicit human lane/stage placement');
  coherentBoardCard(h);
  assert.equal(stageSource(h)?.human, 1);
});

for (const destination of ['workflow', 'generic'] as const)
  test(`R3 F4 human ${destination} placement retires generated stage scope while private fields are erased`, {
    timeout: 10000,
  }, async (t) => {
    const h = await workflowFixture(t);
    assert.ok(h.ticket);
    await h.deliver('blocked');
    await h.app.pipeline.drain();
    assert.equal(stageSource(h)?.human, 0);
    // Unknown lineage must also be retired by the explicit human placement.
    h.db.run("UPDATE workflow_field_source SET source_unknown=1 WHERE card_id=? AND field='stage'", h.ticket.card.id);
    const ticket = getWorkflowTicket(h.ctx, h.ticket.card.id);
    updateWorkflowTicket(h.ctx, ticket.card.id, {
      version: ticket.version,
      nextAction: 'Human safe action',
      buyerId: 'human-reference',
    });
    moveCard(h.ctx, h.ticket.card.id, {
      stageId: destination === 'generic' ? (h.lane.stages[1]?.id as number) : (h.board.stages[2]?.id as number),
    });
    const before = placement(h);
    const owner = stageSource(h);
    assert.equal(owner?.human, 1);
    assert.equal(owner?.source_message_ids, '[]');
    assert.equal(owner?.source_chat_ids, '[]');
    assert.equal(owner?.source_unknown, 0);
    const accountId = await retainOtherChat(h);
    assert.equal(physicalContains(h, privateMarker), true);
    withdrawChat(h.ctx, h.app.host, accountId, h.chatId);
    assert.deepEqual(placement(h), before);
    const fields = h.db.get<{
      next_action: string;
      buyer_id: string;
      blocked_reason: string | null;
      follow_up_at: string | null;
      workstream: string;
    }>('SELECT * FROM workflow_ticket WHERE card_id=?', h.ticket.card.id);
    assert.equal(fields?.next_action, 'Human safe action');
    assert.equal(fields?.buyer_id, 'human-reference');
    assert.equal(fields?.blocked_reason, null);
    assert.equal(fields?.follow_up_at, null);
    assert.equal(fields?.workstream, 'others');
    assertErased(h);
  });

for (const destination of ['workflow', 'generic'] as const)
  test(`R3 F4 erasure independently protects current human ${destination} placement from a legacy obsolete source`, {
    timeout: 10000,
  }, async (t) => {
    const h = await workflowFixture(t);
    assert.ok(h.ticket);
    await h.deliver('blocked');
    await h.app.pipeline.drain();
    const obsolete = stageSource(h);
    assert.ok(obsolete);
    moveCard(h.ctx, h.ticket.card.id, {
      stageId: destination === 'generic' ? (h.lane.stages[1]?.id as number) : (h.board.stages[2]?.id as number),
    });
    // Reconstruct only the actual old provenance defect, independently of the repaired write boundary.
    // The human placement/action log remains real, including its original same-clock timestamp.
    h.db.run(
      "UPDATE workflow_field_source SET human=0,source_message_ids=?,source_chat_ids=?,source_unknown=? WHERE card_id=? AND field='stage'",
      obsolete.source_message_ids,
      obsolete.source_chat_ids,
      obsolete.source_unknown,
      h.ticket.card.id,
    );
    const before = placement(h);
    const accountId = await retainOtherChat(h);
    assert.equal(physicalContains(h, privateMarker), true);
    withdrawChat(h.ctx, h.app.host, accountId, h.chatId);
    assert.deepEqual(placement(h), before);
    assert.equal(stageSource(h), undefined, 'obsolete generated provenance must still be retired');
    assertErased(h);
  });

test('R3 F4 current derived placement resets coherently; failed purge rolls back placement, metadata, sources and history', {
  timeout: 10000,
}, async (t) => {
  const h = await workflowFixture(t);
  assert.ok(h.ticket);
  await h.deliver('blocked');
  await h.app.pipeline.drain();
  let ticket = getWorkflowTicket(h.ctx, h.ticket.card.id);
  assert.equal(ticket.workflowStage, 'blocked');
  updateWorkflowTicket(h.ctx, ticket.card.id, { version: ticket.version, nextAction: 'Human retained action' });
  const accountId = await retainOtherChat(h);
  const snapshot = () =>
    [
      'card',
      'workflow_ticket',
      'workflow_field_source',
      'action_log',
      'message',
      'decision',
      'review_item',
      'chat',
      'card_chat',
    ].map((table) => h.db.all(`SELECT * FROM ${table} ORDER BY rowid`));
  const before = snapshot();
  assert.equal(physicalContains(h, privateMarker), true);
  h.db.run(
    "CREATE TRIGGER f4_purge_fault BEFORE DELETE ON message BEGIN SELECT RAISE(ABORT,'synthetic F4 rollback'); END",
  );
  assert.throws(() => withdrawChat(h.ctx, h.app.host, accountId, h.chatId), /synthetic F4 rollback/);
  assert.deepEqual(snapshot(), before);
  assert.equal(physicalContains(h, privateMarker), true);
  coherentBoardCard(h);
  h.db.run('DROP TRIGGER f4_purge_fault');
  withdrawChat(h.ctx, h.app.host, accountId, h.chatId);
  ticket = getWorkflowTicket(h.ctx, h.ticket.card.id);
  assert.equal(ticket.workflowStage, 'to_be_started');
  assert.equal(ticket.card.laneId, h.board.lane?.id);
  assert.equal(ticket.nextAction, 'Human retained action');
  assert.equal(ticket.blockedReason, null);
  assert.equal(ticket.followUpAt, null);
  assertErased(h);
});
