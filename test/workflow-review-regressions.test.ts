import assert from 'node:assert/strict';
import test from 'node:test';
import { completed, decision, jsonResponse } from '../src/agent/cloud-testing.ts';
import { listReview } from '../src/agent/index.ts';
import { signIn } from '../src/auth/index.ts';
import { archiveLane, getWorkflowBoard } from '../src/board/index.ts';
import type { App, Ctx } from '../src/contracts/index.ts';
import { webTestApp } from '../src/web/testing.ts';
import { workflowFixture } from './workflow-support.ts';

function authenticatedPost(app: App, ctx: Ctx, origin: string, path: string, form: Record<string, string> = {}) {
  const session = signIn(ctx.db, 'alice', 'synthetic-password', ctx.now());
  return app.fetch(
    new Request(`${origin}${path}`, {
      method: 'POST',
      headers: { Cookie: `kanban_session=${session.token}`, Origin: origin },
      body: new URLSearchParams(form),
    }),
  );
}
function laneForm(lane: NonNullable<ReturnType<typeof getWorkflowBoard>['lane']>) {
  const stages = [lane.stages[4], ...lane.stages.slice(0, 4)];
  const form: Record<string, string> = { name: lane.name, sop: lane.sop };
  for (const [i, s] of stages.entries()) {
    assert.ok(s);
    form[`stageId${i}`] = String(s.id);
    form[`stageName${i}`] = s.name;
    form[`stageCriteria${i}`] = s.criteria;
  }
  return form;
}

test('R1 F1 nullable pending workflow join uses Jev and authenticated acceptance cannot inherit OpenAI Completed', {
  timeout: 10000,
}, async (t) => {
  const h = await workflowFixture(t, false);
  archiveLane(h.ctx, h.lane.id);
  await h.deliver('one');
  await h.app.pipeline.drain();
  const p = listReview(h.ctx).find((r) => r.kind === 'new_card');
  assert.ok(p);
  const before = h.calls.length;
  h.handlers.general = async (input) =>
    jsonResponse(
      completed(
        decision(input, {
          disposition: 'join',
          cardId: null,
          proposalId: p.id,
          laneId: null,
          summary: 'Only engineering assessment is underway, not live usage.',
          move: {
            toStageId: h.board.stages[4]?.id as number,
            criterion: 'General model says Completed',
            evidenceMessageIds: [input.message.id],
            confidence: 1,
          },
        }),
      ),
    );
  await h.deliver('two');
  await h.app.pipeline.drain();
  const grouped = listReview(h.ctx).filter((r) => r.kind === 'new_card');
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0]?.messages.length, 2);
  const response = await authenticatedPost(h.app, h.ctx, h.config.origin, `/review/${p.id}/accept`);
  assert.equal(response.status, 303);
  const ticket = getWorkflowBoard(h.ctx).tickets[0];
  assert.ok(ticket);
  const jevCalls = h.calls.slice(before).filter((c) => c.url.includes('systemone')).length;
  console.log(
    JSON.stringify({ regression: 'F1', jevCalls, acceptHTTP: response.status, actualStage: ticket.workflowStage }),
  );
  assert.equal(jevCalls, 1, 'nullable proposal joins must request workflow Jev even with no other active lane');
  assert.equal(ticket.workflowStage, 'work_in_progress', 'only the evidenced Jev stage may be accepted');
});

test('R1 F2 native lane reorder then import seeds To be started independently of stage position', {
  timeout: 10000,
}, async (t) => {
  const h = await webTestApp(t);
  const ctx = h.ctxFor('alice'),
    cookie = h.cookieFor('alice');
  assert.equal((await h.post('/workflow/configure', { confirm: 'on' }, { cookie })).status, 303);
  const b = getWorkflowBoard(ctx);
  assert.ok(b.lane);
  assert.equal((await h.post(`/lanes/${b.lane.id}`, laneForm(b.lane), { cookie })).status, 303);
  const response = await h.post(
    '/workflow/import',
    { titles: 'New never-contacted lead', workstream: 'buyer' },
    { cookie },
  );
  assert.equal(response.status, 303);
  const ticket = getWorkflowBoard(ctx).tickets[0];
  assert.ok(ticket);
  console.log(JSON.stringify({ regression: 'F2', importHTTP: response.status, actualStage: ticket.workflowStage }));
  assert.equal(ticket.workflowStage, 'to_be_started');
});
