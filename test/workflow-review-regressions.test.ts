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

for (const failure of ['failed', 'no-evidence', 'threshold'] as const)
  test(`R1 F1 ${failure} nullable join preserves grouped review and accepts only a To be started lead`, {
    timeout: 10000,
  }, async (t) => {
    const h = await workflowFixture(t, false);
    archiveLane(h.ctx, h.lane.id);
    await h.deliver('one');
    await h.app.pipeline.drain();
    const p = listReview(h.ctx).find((r) => r.kind === 'new_card');
    assert.ok(p);
    h.policy.failed = failure === 'failed';
    h.policy.missingSupport = failure === 'no-evidence';
    if (failure === 'threshold') h.policy.confidence = 0.85;
    const before = h.calls.length;
    h.handlers.general = async (input) =>
      jsonResponse(
        completed(
          decision(input, {
            disposition: 'join',
            cardId: null,
            proposalId: p.id,
            laneId: null,
            move: {
              toStageId: h.board.stages[4]?.id as number,
              criterion: 'Untrusted general Completed',
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
    assert.equal(grouped[0]?.proposal.kind === 'new_card' ? grouped[0].proposal.move : undefined, null);
    assert.match(grouped[0]?.reason ?? '', /Jev unauthorised|missing evidence|confidence does not strictly exceed/);
    assert.equal(h.calls.slice(before).filter((c) => c.url.includes('systemone')).length, 1);
    assert.equal((await authenticatedPost(h.app, h.ctx, h.config.origin, `/review/${p.id}/accept`)).status, 303);
    assert.equal(getWorkflowBoard(h.ctx).tickets[0]?.workflowStage, 'to_be_started');
  });

test('R1 F1 accepted nullable join resolves its exact result among multiple linked workflow cards', {
  timeout: 10000,
}, async (t) => {
  const { createWorkflowTicket } = await import('../src/board/index.ts');
  const h = await workflowFixture(t, false);
  archiveLane(h.ctx, h.lane.id);
  await h.deliver('one');
  await h.app.pipeline.drain();
  const p = listReview(h.ctx).find((r) => r.kind === 'new_card');
  assert.ok(p);
  assert.equal((await authenticatedPost(h.app, h.ctx, h.config.origin, `/review/${p.id}/accept`)).status, 303);
  const original = getWorkflowBoard(h.ctx).tickets[0];
  assert.ok(original);
  const other = createWorkflowTicket(h.ctx, { title: 'A separate known lead', chatId: h.chatId });
  const before = h.calls.length;
  h.handlers.general = async (input) =>
    jsonResponse(
      completed(
        decision(input, {
          disposition: 'join',
          cardId: null,
          proposalId: p.id,
          laneId: null,
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
  const tickets = getWorkflowBoard(h.ctx).tickets;
  assert.equal(tickets.length, 2);
  assert.equal(tickets.find((c) => c.card.id === original.card.id)?.workflowStage, 'work_in_progress');
  assert.equal(tickets.find((c) => c.card.id === other.card.id)?.workflowStage, 'to_be_started');
  assert.equal(h.calls.slice(before).filter((c) => c.url.includes('systemone')).length, 1);
  assert.equal(
    h.db.get<{ card_id: number }>(
      "SELECT card_id FROM card_message WHERE message_id=(SELECT id FROM message WHERE message_key='two')",
    )?.card_id,
    original.card.id,
  );
});

test('R1 F1 native acceptance rejects an unbound legacy stage even when ordinary review snapshots are current', {
  timeout: 10000,
}, async (t) => {
  const { joinProposal } = await import('../src/agent/review-groups.ts');
  const { bindReviewState, captureReviewSources } = await import('../src/agent/review-state.ts');
  const h = await workflowFixture(t, false);
  await h.deliver('one');
  await h.app.pipeline.drain();
  const p = listReview(h.ctx).find((r) => r.kind === 'new_card');
  assert.ok(p);
  const source = h.db.get<{ message_id: number; decision_id: number }>(
    'SELECT message_id,decision_id FROM review_message WHERE review_item_id=?',
    p.id,
  );
  assert.ok(source);
  const agent = { ...h.ctx, actor: { kind: 'agent' as const } };
  // Model the exact pre-correction persisted join, with real native snapshot binding.
  h.db.tx(() => {
    joinProposal(
      agent,
      p.id,
      source.message_id,
      source.decision_id,
      'Unsupported legacy stage',
      { toStageId: h.board.stages[4]?.id as number, criterion: 'OpenAI-only stage' },
      'Legacy join',
      'low_confidence',
      1,
    );
    const sources = captureReviewSources(agent, { chatIds: [h.chatId], messageIds: [source.message_id] });
    assert.ok(sources);
    bindReviewState(agent, source.decision_id, sources);
  });
  assert.equal(listReview(h.ctx).find((r) => r.id === p.id)?.canAccept, false);
  assert.equal((await authenticatedPost(h.app, h.ctx, h.config.origin, `/review/${p.id}/accept`)).status, 409);
  assert.equal(getWorkflowBoard(h.ctx).tickets.length, 0);
});

test('R1 F1 dismissal during pending proposal Jev discards late judgment and cannot resurrect the review', {
  timeout: 10000,
}, async (t) => {
  const { dismissReview } = await import('../src/agent/index.ts');
  const h = await workflowFixture(t, false);
  await h.deliver('one');
  await h.app.pipeline.drain();
  const p = listReview(h.ctx).find((r) => r.kind === 'new_card');
  assert.ok(p);
  h.handlers.general = async (input) =>
    jsonResponse(completed(decision(input, { disposition: 'join', cardId: null, proposalId: p.id, laneId: null })));
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<Response>();
  const original = h.handlers.movement;
  h.handlers.movement = async (body) => {
    entered.resolve();
    return release.promise.then(() => original(body));
  };
  await h.deliver('two');
  const pending = h.app.pipeline.processNext();
  await entered.promise;
  dismissReview(h.ctx, p.id);
  release.resolve(new Response());
  assert.equal(await pending, null);
  assert.equal(h.db.get<{ status: string }>('SELECT status FROM review_item WHERE id=?', p.id)?.status, 'dismissed');
  assert.equal((await authenticatedPost(h.app, h.ctx, h.config.origin, `/review/${p.id}/accept`)).status, 409);
  assert.equal(getWorkflowBoard(h.ctx).tickets.length, 0);
});

test('R1 F2 reordered workflow defaults cover generic card, public create and actual MCP SDK; explicit manual placement remains allowed', {
  timeout: 10000,
}, async (t) => {
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const { createCard, createWorkflowTicket } = await import('../src/board/index.ts');
  const { createCredential } = await import('../src/auth/index.ts');
  const h = await webTestApp(t);
  const ctx = h.ctxFor('alice'),
    cookie = h.cookieFor('alice');
  await h.post('/workflow/configure', { confirm: 'on' }, { cookie });
  const b = getWorkflowBoard(ctx);
  assert.ok(b.lane);
  assert.equal((await h.post(`/lanes/${b.lane.id}`, laneForm(b.lane), { cookie })).status, 303);
  assert.equal(createCard(ctx, { laneId: b.lane.id, title: 'Generic default' }).stageId, b.stages[0]?.id);
  assert.equal(createWorkflowTicket(ctx, { title: 'Public default' }).workflowStage, 'to_be_started');
  assert.equal(
    createCard(ctx, { laneId: b.lane.id, title: 'Explicit human placement', stageId: b.stages[4]?.id as number })
      .stageId,
    b.stages[4]?.id,
  );
  const credential = createCredential(ctx, {
    name: 'synthetic-reordered-writer',
    scopeMessages: false,
    scopeWrite: true,
  });
  const client = new Client(
    { name: 'synthetic-regression', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://localhost:8787/mcp'), {
        requestInit: { headers: { Authorization: `Bearer ${credential.token}` } },
        fetch: async (url, init) => h.app.fetch(new Request(String(url), init)),
      }),
    );
    const result = await client.callTool({ name: 'create_ticket', arguments: { title: 'MCP default' } });
    assert.equal(result.isError, undefined);
    assert.equal(
      (result.structuredContent as { result: { workflowStage: string } }).result.workflowStage,
      'to_be_started',
    );
  } finally {
    await client.close();
  }
});

test('R1 F2 reordered workflow review acceptance defaults to semantic To be started', { timeout: 10000 }, async (t) => {
  const h = await workflowFixture(t, false);
  archiveLane(h.ctx, h.lane.id);
  assert.ok(h.board.lane);
  assert.equal(
    (await authenticatedPost(h.app, h.ctx, h.config.origin, `/lanes/${h.board.lane.id}`, laneForm(h.board.lane)))
      .status,
    303,
  );
  await h.deliver('one');
  await h.app.pipeline.drain();
  const p = listReview(h.ctx).find((r) => r.kind === 'new_card');
  assert.ok(p);
  assert.equal((await authenticatedPost(h.app, h.ctx, h.config.origin, `/review/${p.id}/accept`)).status, 303);
  assert.equal(getWorkflowBoard(h.ctx).tickets[0]?.workflowStage, 'to_be_started');
});

test('R1 F2 configured stage identities cannot be removed, replaced, renamed or redefined; unrelated generic editing stays functional', {
  timeout: 10000,
}, async (t) => {
  const { createCard, createLane, updateLane } = await import('../src/board/index.ts');
  const h = await webTestApp(t);
  const ctx = h.ctxFor('alice'),
    cookie = h.cookieFor('alice');
  await h.post('/workflow/configure', { confirm: 'on' }, { cookie });
  const b = getWorkflowBoard(ctx);
  assert.ok(b.lane);
  const lane = b.lane;
  const before = JSON.stringify(h.db.all('SELECT * FROM action_log'));
  for (const change of ['remove', 'replace', 'rename', 'criteria', 'add']) {
    const form = laneForm(lane);
    if (change === 'remove') for (const key of ['stageId4', 'stageName4', 'stageCriteria4']) delete form[key];
    if (change === 'replace') form.stageId0 = '';
    if (change === 'rename') form.stageName0 = 'Unmapped semantic name';
    if (change === 'criteria') form.stageCriteria0 = 'Outreach alone completes work';
    if (change === 'add') {
      form.stageId5 = '';
      form.stageName5 = 'Extra';
      form.stageCriteria5 = 'New semantics';
    }
    assert.equal((await h.post(`/lanes/${lane.id}`, form, { cookie })).status, 422, change);
  }
  assert.equal(JSON.stringify(h.db.all('SELECT * FROM action_log')), before);
  const generic = createLane(ctx, {
    name: 'Unrelated generic',
    sop: 'Generic',
    stages: [
      { name: 'First', criteria: '' },
      { name: 'Second', criteria: 'Existing' },
    ],
  });
  const updated = updateLane(ctx, generic.id, {
    stages: [
      { id: generic.stages[1]?.id, name: 'Renamed second first', criteria: 'Custom' },
      { id: generic.stages[0]?.id, name: 'Renamed first second', criteria: '' },
    ],
  });
  assert.equal(
    createCard(ctx, { laneId: updated.id, title: 'Unrelated generic initial' }).stageId,
    updated.stages[0]?.id,
  );
});
