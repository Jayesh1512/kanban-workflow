import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { completed, decision, jevAnswer, jsonResponse } from '../src/agent/cloud-testing.ts';
import { listReview } from '../src/agent/index.ts';
import { signIn } from '../src/auth/index.ts';
import { archiveLane, getWorkflowBoard } from '../src/board/index.ts';
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
  h.handlers.movement = async (body) => jsonResponse({ ...jevAnswer(body), model: 'typesafe-ai/jev' });
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
  assert.deepEqual(h.db.get('SELECT status,result_card_id FROM review_item WHERE id=?', h.proposal.id), {
    status: 'changed',
    result_card_id: h.ticket.card.id,
  });
});
