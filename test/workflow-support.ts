import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import {
  cloudFixture,
  completed,
  decision,
  jsonResponse,
  recording,
  type WireRequest,
} from '../src/agent/cloud-testing.ts';
import { configureWorkflow, createWorkflowTicket } from '../src/board/index.ts';
import type { FixtureLine, WorkflowAction, WorkflowStage } from '../src/contracts/index.ts';

export function workflowAnswer(
  body: WireRequest,
  selections: Record<string, string>,
  confidence = 0.97,
  missingSupport = false,
) {
  const state = JSON.parse(body.state) as { messageId: number };
  const answers = Object.fromEntries(
    Object.entries(body.questions).map(([id, q]) => {
      const choice = id.startsWith('support:')
        ? missingSupport
          ? 'review'
          : `message:${state.messageId}`
        : (selections[id] ?? 'none');
      return [
        id,
        {
          type: 'choice',
          choice,
          confidence,
          probabilities: Object.fromEntries(Object.keys(q.criteria).map((key) => [key, Number(key === choice)])),
        },
      ];
    }),
  );
  return { model: 'typesafe-ai/jev', answers, usage: { input_tokens: 300, output_tokens: 30 } };
}
export async function workflowFixture(t: TestContext, seed = true) {
  const text: Record<string, string> = {
    one: 'Hi Dap Looker, would you like to try our product?',
    two: 'Yes, interested. Our engineering team is assessing the integration.',
    three: 'We ran the integration tests and executed the sample command successfully.',
    other: 'UNSELECTED_PRIVATE_WORKFLOW_MARKER',
  };
  const lines = recording().map(
    (l): FixtureLine =>
      l.t === 'message'
        ? {
            ...l,
            message: {
              ...l.message,
              text: text[l.message.key] ?? '',
              sentAt: l.message.sentAt.replace('2026-09-01', '2026-10-16'),
              sender:
                l.message.key === 'one' ? { userKey: 'self', displayName: 'Alice', handle: null } : l.message.sender,
            },
          }
        : l,
  );
  for (const [i, key] of ['complete', 'followup', 'blocked', 'buyer', 'noresponse', 'retained', 'refill'].entries()) {
    lines.push(
      {
        t: 'message',
        account: 'alice',
        delivery: 'live',
        chatKey: ['retained', 'refill'].includes(key) ? 'other' : 'work',
        message: {
          key,
          nativeId: key,
          cursor: String(i + 5),
          sender: { userKey: 'outside', displayName: 'Outside', handle: null },
          sentAt: `2026-10-16T10:00:1${i}.000Z`,
          text:
            {
              complete: 'We are fully integrated and using it live now.',
              followup: 'Please follow up Monday.',
              blocked: 'PRIVATE_WORKFLOW_BLOCKER_MARKER: credentials are blocked; follow up Monday.',
              buyer: 'buyerId: customer_123 (reference only, no testing or live usage yet).',
              noresponse: 'Still waiting for a reply; follow up Monday.',
              retained: 'A retained included-chat message.',
              refill: 'Our engineering team is assessing this retained integration.',
            }[key] ?? '',
          media: null,
          replyToNativeId: null,
          editedAt: null,
        },
      },
      { t: 'mark', name: key },
    );
  }
  const h = await cloudFixture(t, { gateway: true, recordingLines: lines });
  h.advance(Date.parse('2026-10-16T10:00:00Z') - h.ctx.now().getTime());
  const board = configureWorkflow(h.ctx);
  const chatId = h.db.get<{ id: number }>("SELECT id FROM chat WHERE chat_key='work'")?.id;
  assert.ok(chatId);
  const ticket = seed ? createWorkflowTicket(h.ctx, { title: 'Dap Looker', chatId }) : null;
  h.handlers.general = async (input) =>
    jsonResponse(
      completed(
        decision(input, {
          disposition: ticket ? 'attach' : 'create',
          cardId: ticket?.card.id ?? null,
          laneId: board.lane?.id ?? null,
          move: {
            toStageId: board.stages[4]?.id as number,
            criterion: 'General model must NOT control workflow stages',
            evidenceMessageIds: [input.message.id],
            confidence: 1,
          },
        }),
      ),
    );
  const policy = { confidence: 0.97, failed: false, missingSupport: false, allowOtherContext: false };
  const selections: Record<
    string,
    { stage: WorkflowStage; action: WorkflowAction; date?: boolean; buyerId?: boolean }
  > = {
    one: { stage: 'to_be_started', action: 'outreach' },
    two: { stage: 'work_in_progress', action: 'engineering_assessment' },
    three: { stage: 'integrations', action: 'run_test' },
    complete: { stage: 'completed', action: 'confirm_live' },
    followup: { stage: 'work_in_progress', action: 'follow_up', date: true },
    blocked: { stage: 'blocked', action: 'resolve_blocker', date: true },
    buyer: { stage: 'to_be_started', action: 'follow_up', buyerId: true },
    retained: { stage: 'to_be_started', action: 'none' },
    other: { stage: 'to_be_started', action: 'none' },
    refill: { stage: 'work_in_progress', action: 'engineering_assessment' },
    noresponse: { stage: 'to_be_started', action: 'follow_up', date: true },
  };
  h.handlers.movement = async (body) => {
    assert.equal(body.model, 'typesafe-ai/jev');
    assert.deepEqual(Object.keys(body).sort(), ['model', 'questions', 'state']);
    assert.ok(Object.values(body.questions).every((q) => q.type === 'choice'));
    assert.ok(body.questions.stage);
    assert.equal(body.questions.movement, undefined);
    if (!policy.allowOtherContext) assert.doesNotMatch(body.state, /UNSELECTED_PRIVATE_WORKFLOW_MARKER/);
    const state = JSON.parse(body.state) as {
      messageId: number;
      evidence: { id: number; key: string }[];
      dates: { id: string; messageId: number }[];
      buyerIds: { id: string; messageId: number }[];
    };
    const key = state.evidence.find((e) => e.id === state.messageId)?.key ?? '';
    const pick = selections[key];
    assert.ok(pick);
    if (policy.failed) return jsonResponse({ error: 'synthetic paid-credit restriction' }, 403);
    return jsonResponse(
      workflowAnswer(
        body,
        {
          stage: pick.stage,
          workstream: 'buyer',
          action: pick.action,
          date: pick.date ? (state.dates.find((c) => c.messageId === state.messageId)?.id ?? 'none') : 'none',
          buyerId: pick.buyerId ? (state.buyerIds.find((c) => c.messageId === state.messageId)?.id ?? 'none') : 'none',
        },
        policy.confidence,
        policy.missingSupport,
      ),
    );
  };
  return { ...h, chatId, ticket, board, policy };
}
