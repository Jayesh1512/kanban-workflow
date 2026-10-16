import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { completed, decision, jevAnswer, jsonResponse } from '../src/agent/cloud-testing.ts';
import { listReview } from '../src/agent/index.ts';
import { signIn } from '../src/auth/index.ts';
import { archiveLane, createLane, createWorkflowTicket, getWorkflowBoard, moveCard } from '../src/board/index.ts';
import { workflowFixture } from './workflow-support.ts';

async function acceptedGenericResult(t: TestContext) {
  const h = await workflowFixture(t, false);
  const workflowHandler = h.handlers.movement;
  const post = (path: string, form: Record<string, string> = {}) => {
    const session = signIn(h.db, 'alice', 'synthetic-password', h.ctx.now());
    return h.app.fetch(
      new Request(`${h.config.origin}${path}`, {
        method: 'POST',
        headers: { Cookie: `kanban_session=${session.token}`, Origin: h.config.origin },
        body: new URLSearchParams(form),
      }),
    );
  };
  h.handlers.general = async (input) =>
    jsonResponse(completed(decision(input, { disposition: 'create', laneId: h.lane.id, move: null })));
  // Initial extraction is genuinely generic: answer the generic movement protocol with a valid stay.
  h.handlers.movement = async (body) => jsonResponse({ ...(jevAnswer(body) as object), model: 'typesafe-ai/jev' });
  await h.deliver('one');
  await h.app.pipeline.drain();
  const proposal = listReview(h.ctx).find((r) => r.kind === 'new_card');
  assert.ok(proposal);
  assert.equal(proposal.proposal.kind === 'new_card' && proposal.proposal.laneId, h.lane.id);
  const original = h.db.get('SELECT proposal FROM review_item WHERE id=?', proposal.id);
  assert.equal(
    (
      await post(`/review/${proposal.id}/change`, {
        to: 'new_card',
        laneId: String(h.board.lane?.id),
        title: 'Human accepted configured lead',
        summary: 'An uncontacted lead.',
        stageId: '',
      })
    ).status,
    303,
  );
  const ticket = getWorkflowBoard(h.ctx).tickets[0];
  assert.ok(ticket);
  assert.equal(ticket.workflowStage, 'to_be_started');
  archiveLane(h.ctx, h.lane.id);
  // Later requests must answer the actual workflow wire, including independent evidence choices.
  h.handlers.movement = workflowHandler;
  h.handlers.general = async (input) =>
    jsonResponse(
      completed(
        decision(input, {
          disposition: 'join',
          cardId: null,
          proposalId: proposal.id,
          laneId: null,
          summary: 'Only engineering assessment, not live usage.',
          move: {
            toStageId: h.board.stages[4]?.id as number,
            criterion: 'OpenAI-only Completed',
            evidenceMessageIds: [input.message.id],
            confidence: 1,
          },
        }),
      ),
    );
  return { ...h, post, proposal, original, ticket };
}

test('R2 F3 native generic proposal changed to workflow routes nullable join through actual Jev assessment', {
  timeout: 10000,
}, async (t) => {
  const h = await acceptedGenericResult(t);
  const before = h.calls.length;
  await h.deliver('two');
  await h.app.pipeline.drain();
  const move = listReview(h.ctx).find((r) => r.kind === 'move');
  const accept = move ? (await h.post(`/review/${move.id}/accept`)).status : null;
  const ticket = getWorkflowBoard(h.ctx).tickets.find((c) => c.card.id === h.ticket.card.id);
  const jevCalls = h.calls.slice(before).filter((c) => c.url.includes('systemone')).length;
  console.log(
    JSON.stringify({
      regression: 'F3',
      jevCalls,
      canAccept: move?.canAccept,
      acceptHTTP: accept,
      stage: ticket?.workflowStage,
    }),
  );
  assert.equal(jevCalls, 1);
  assert.equal(ticket?.workflowStage, 'work_in_progress');
  assert.equal(move, undefined, 'OpenAI-only standalone workflow moves must not be offered');
  assert.deepEqual(h.db.get('SELECT proposal FROM review_item WHERE id=?', h.proposal.id), h.original);
  const settled = h.db.get<{ status: string; result_card_id: number }>(
    'SELECT status,result_card_id FROM review_item WHERE id=?',
    h.proposal.id,
  );
  assert.equal(settled?.status, 'changed');
  assert.equal(settled?.result_card_id, h.ticket.card.id);
});

test('R2 F3 generic commit boundary cannot generate or apply a standalone workflow move', {
  timeout: 10000,
}, async (t) => {
  const { commitDecision } = await import('../src/agent/process.ts');
  const { spineInput } = await import('../src/agent/spine-input.ts');
  const { captureReviewSources } = await import('../src/agent/review-state.ts');
  const { setSetting } = await import('../src/auth/index.ts');
  const h = await acceptedGenericResult(t);
  setSetting(h.ctx, 'review_threshold', 0.8);
  await h.deliver('two');
  const message = h.db.get<{ id: number }>("SELECT id FROM message WHERE message_key='two'");
  assert.ok(message);
  const agent = { ...h.ctx, actor: { kind: 'agent' as const } };
  const input = spineInput(agent, message.id);
  const extraction = decision(input, {
    disposition: 'join',
    cardId: null,
    proposalId: h.proposal.id,
    laneId: null,
    move: {
      toStageId: h.board.stages[4]?.id as number,
      criterion: 'OpenAI-only Completed',
      evidenceMessageIds: [message.id],
      confidence: 1,
    },
  });
  const sources = captureReviewSources(agent, { chatIds: [h.chatId], messageIds: [message.id] });
  assert.ok(sources);
  h.db.tx(() =>
    commitDecision(agent, input, extraction, extraction, 'synthetic-general-extraction', null, null, sources),
  );
  assert.equal(getWorkflowBoard(h.ctx).tickets[0]?.workflowStage, 'to_be_started');
  assert.equal(
    listReview(h.ctx).some((r) => r.kind === 'move'),
    false,
  );
  assert.ok(listReview(h.ctx).some((r) => r.kind === 'model_failed' && r.reason === 'workflow_stage_requires_jev'));
});

for (const failure of ['failed', 'missingSupport', 'threshold'] as const)
  test(`R2 F3 ${failure} accepted-result Jev cannot fall back to OpenAI Completed`, { timeout: 10000 }, async (t) => {
    const h = await acceptedGenericResult(t);
    h.policy.failed = failure === 'failed';
    h.policy.missingSupport = failure === 'missingSupport';
    if (failure === 'threshold') h.policy.confidence = 0.85;
    const before = h.calls.length;
    await h.deliver('two');
    await h.app.pipeline.drain();
    assert.equal(h.calls.slice(before).filter((c) => c.url.includes('systemone')).length, 1);
    assert.equal(getWorkflowBoard(h.ctx).tickets[0]?.workflowStage, 'to_be_started');
    assert.ok(listReview(h.ctx).some((r) => r.kind === 'model_failed' && !r.canAccept));
    assert.equal(
      listReview(h.ctx).some((r) => r.kind === 'move'),
      false,
    );
    assert.deepEqual(h.db.get('SELECT proposal FROM review_item WHERE id=?', h.proposal.id), h.original);
  });

test('R2 F3 persisted standalone OpenAI move is refused by native accept but explicit human stage change works', {
  timeout: 10000,
}, async (t) => {
  const { addReview } = await import('../src/agent/review-groups.ts');
  const { bindReviewState, captureReviewSources } = await import('../src/agent/review-state.ts');
  const h = await acceptedGenericResult(t);
  const source = h.db.get<{ message_id: number; decision_id: number }>(
    'SELECT message_id,decision_id FROM review_message WHERE review_item_id=?',
    h.proposal.id,
  );
  assert.ok(source);
  const agent = { ...h.ctx, actor: { kind: 'agent' as const } };
  // Reconstruct a persisted pre-fix standalone review through real native settlement binding.
  const id = h.db.tx(() => {
    const id = addReview(
      agent,
      {
        do: 'review',
        kind: 'move',
        groupKey: `card:${h.ticket.card.id}`,
        chatId: h.chatId,
        why: 'low_confidence',
        confidence: 1,
        proposal: {
          kind: 'move',
          cardId: h.ticket.card.id,
          toStageId: h.board.stages[4]?.id as number,
          criterion: 'OpenAI only, no Jev authority',
        },
      },
      [source.message_id],
      source.decision_id,
      'Synthetic persisted pre-fix review',
    );
    const sources = captureReviewSources(agent, { chatIds: [h.chatId], messageIds: [source.message_id] });
    assert.ok(sources);
    bindReviewState(agent, source.decision_id, sources);
    return id;
  });
  assert.equal(listReview(h.ctx).find((r) => r.id === id)?.canAccept, false);
  assert.equal((await h.post(`/review/${id}/accept`)).status, 409);
  assert.equal(getWorkflowBoard(h.ctx).tickets[0]?.workflowStage, 'to_be_started');
  assert.equal(
    (await h.post(`/review/${id}/change`, { to: 'stage', stageId: String(h.board.stages[4]?.id) })).status,
    303,
  );
  assert.equal(getWorkflowBoard(h.ctx).tickets[0]?.workflowStage, 'completed');
});

for (const identity of ['wrong-chat', 'not-linked'] as const)
  test(`R2 F3 ${identity} accepted result cannot use another linked workflow ticket`, { timeout: 10000 }, async (t) => {
    const h = await acceptedGenericResult(t);
    const other = createWorkflowTicket(h.ctx, { title: 'Unrelated fallback lead', chatId: h.chatId });
    if (identity === 'wrong-chat') {
      const chatId = h.db.run(
        "INSERT INTO chat(channel,chat_key,kind,title,created_at) VALUES ('fixture','wrong-chat','group','Synthetic unrelated chat',?)",
        h.ctx.now().toISOString(),
      ).lastInsertRowid;
      h.db.run('UPDATE review_item SET chat_id=? WHERE id=?', chatId, h.proposal.id);
    } else h.db.run('DELETE FROM card_chat WHERE card_id=? AND chat_id=?', h.ticket.card.id, h.chatId);
    const before = h.calls.length;
    await h.deliver('two');
    await h.app.pipeline.drain();
    assert.equal(h.calls.slice(before).filter((c) => c.url.includes('systemone')).length, 0);
    assert.equal(
      getWorkflowBoard(h.ctx).tickets.find((c) => c.card.id === other.card.id)?.workflowStage,
      'to_be_started',
    );
    assert.equal(
      getWorkflowBoard(h.ctx).tickets.find((c) => c.card.id === h.ticket.card.id)?.workflowStage,
      'to_be_started',
    );
    assert.equal(
      listReview(h.ctx).some((r) => r.kind === 'move'),
      false,
    );
    assert.equal(
      h.db.get("SELECT card_id FROM card_message WHERE message_id=(SELECT id FROM message WHERE message_key='two')"),
      undefined,
    );
  });

test('R2 F3 changed result identity during workflow Jev discards the late answer', { timeout: 10000 }, async (t) => {
  const h = await acceptedGenericResult(t);
  const other = createWorkflowTicket(h.ctx, { title: 'Another exact result', chatId: h.chatId });
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const original = h.handlers.movement;
  h.handlers.movement = async (body) => {
    entered.resolve();
    await release.promise;
    return original(body);
  };
  await h.deliver('two');
  const pending = h.app.pipeline.processNext();
  await entered.promise;
  h.db.run('UPDATE review_item SET result_card_id=? WHERE id=?', other.card.id, h.proposal.id);
  const decisions = h.db.all('SELECT * FROM decision');
  release.resolve();
  assert.equal(await pending, null);
  assert.deepEqual(h.db.all('SELECT * FROM decision'), decisions);
  assert.ok(getWorkflowBoard(h.ctx).tickets.every((c) => c.workflowStage === 'to_be_started'));
  assert.equal(
    h.db.get("SELECT card_id FROM card_message WHERE message_id=(SELECT id FROM message WHERE message_key='two')"),
    undefined,
  );
});

test('R2 F3 current generic result keeps generic same-lane review acceptance', { timeout: 10000 }, async (t) => {
  const h = await acceptedGenericResult(t);
  const lane = createLane(h.ctx, {
    name: 'Current generic',
    sop: 'Generic work',
    stages: [
      { name: 'First', criteria: '' },
      { name: 'Second', criteria: 'Generic progress' },
    ],
  });
  moveCard(h.ctx, h.ticket.card.id, { stageId: lane.stages[0]?.id as number });
  archiveLane(h.ctx, h.board.lane?.id as number);
  h.handlers.general = async (input) =>
    jsonResponse(
      completed(
        decision(input, {
          disposition: 'join',
          cardId: null,
          proposalId: h.proposal.id,
          laneId: null,
          move: {
            toStageId: lane.stages[1]?.id as number,
            criterion: 'Generic progress',
            evidenceMessageIds: [input.message.id],
            confidence: 1,
          },
        }),
      ),
    );
  await h.deliver('two');
  await h.app.pipeline.drain();
  const move = listReview(h.ctx).find((r) => r.kind === 'move');
  assert.ok(move?.canAccept);
  assert.equal((await h.post(`/review/${move.id}/accept`)).status, 303);
  assert.equal(
    h.db.get<{ stage_id: number }>('SELECT stage_id FROM card WHERE id=?', h.ticket.card.id)?.stage_id,
    lane.stages[1]?.id,
  );
});

test('R2 F3 current generic result can still receive a correlated Jev cross-lane review into workflow', {
  timeout: 10000,
}, async (t) => {
  const h = await acceptedGenericResult(t);
  const lane = createLane(h.ctx, {
    name: 'Current generic',
    sop: 'Generic work',
    stages: [
      { name: 'First', criteria: '' },
      { name: 'Second', criteria: 'Generic progress' },
    ],
  });
  moveCard(h.ctx, h.ticket.card.id, { stageId: lane.stages[0]?.id as number });
  h.handlers.general = async (input) =>
    jsonResponse(
      completed(
        decision(input, { disposition: 'join', cardId: null, proposalId: h.proposal.id, laneId: null, move: null }),
      ),
    );
  h.handlers.movement = async (body) => {
    assert.ok(body.questions.movement);
    assert.equal(body.questions.stage, undefined);
    const selected = Object.keys(body.questions.movement.criteria).find((id) =>
      id.includes(`:stage:${h.board.stages[1]?.id}:`),
    );
    assert.ok(selected);
    return jsonResponse({ ...(jevAnswer(body, selected) as object), model: 'typesafe-ai/jev' });
  };
  await h.deliver('two');
  await h.app.pipeline.drain();
  const move = listReview(h.ctx).find((r) => r.kind === 'move');
  assert.ok(move?.canAccept);
  assert.equal((await h.post(`/review/${move.id}/accept`)).status, 303);
  assert.equal(getWorkflowBoard(h.ctx).tickets[0]?.workflowStage, 'work_in_progress');
});
