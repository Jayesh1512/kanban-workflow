import assert from 'node:assert/strict';
import test from 'node:test';
import { completed, decision, jsonResponse } from '../src/agent/cloud-testing.ts';
import { listReview } from '../src/agent/index.ts';
import { getWorkflowTicket } from '../src/board/index.ts';
import { workflowFixture } from './workflow-support.ts';

test('R1 F1 an unoffered nullable proposal cannot fall back to a different linked workflow ticket', {
  timeout: 10000,
}, async (t) => {
  const h = await workflowFixture(t);
  assert.ok(h.ticket);
  await h.deliver('one');
  await h.app.pipeline.drain();
  const before = h.calls.length;
  h.handlers.general = async (input) =>
    jsonResponse(
      completed(
        decision(input, {
          disposition: 'join',
          cardId: null,
          proposalId: 999999,
          laneId: h.board.lane?.id ?? null,
          move: {
            toStageId: h.board.stages[4]?.id as number,
            criterion: 'Untrusted Completed',
            evidenceMessageIds: [input.message.id],
            confidence: 1,
          },
        }),
      ),
    );
  await h.deliver('two');
  await h.app.pipeline.drain();
  assert.equal(h.calls.slice(before).filter((c) => c.url.includes('systemone')).length, 0);
  assert.equal(getWorkflowTicket(h.ctx, h.ticket.card.id).workflowStage, 'to_be_started');
  assert.equal(
    h.db.get("SELECT card_id FROM card_message WHERE message_id=(SELECT id FROM message WHERE message_key='two')"),
    undefined,
  );
  assert.ok(listReview(h.ctx).some((r) => r.kind === 'model_failed' && r.reason === 'unknown_identifier'));
});
