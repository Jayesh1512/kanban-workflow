import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { acceptReview, listReview } from '../src/agent/index.ts';
import {
  attachMessage,
  getDailyPriorities,
  getWorkflowBoard,
  getWorkflowTicket,
  moveWorkflowTicket,
  updateWorkflowTicket,
} from '../src/board/index.ts';
import { withdrawChat } from '../src/purge/index.ts';
import { workflowFixture } from './workflow-support.ts';

test('transcript: outreach stays seeded, substantive response advances, actual test and live assertions advance through real pipeline', {
  timeout: 10000,
}, async (t) => {
  const h = await workflowFixture(t);
  assert.ok(h.ticket);
  await h.deliver('one');
  await h.app.pipeline.drain();
  let c = getWorkflowTicket(h.ctx, h.ticket.card.id);
  assert.equal(c.workflowStage, 'to_be_started');
  assert.equal(c.workstream, 'buyer');
  await h.deliver('two');
  await h.app.pipeline.drain();
  c = getWorkflowTicket(h.ctx, c.card.id);
  assert.equal(c.workflowStage, 'work_in_progress');
  await h.deliver('three');
  await h.app.pipeline.drain();
  c = getWorkflowTicket(h.ctx, c.card.id);
  assert.equal(c.workflowStage, 'integrations');
  await h.deliver('complete');
  await h.app.pipeline.drain();
  c = getWorkflowTicket(h.ctx, c.card.id);
  assert.equal(c.workflowStage, 'completed');
  assert.equal(getWorkflowBoard(h.ctx).tickets.length, 1);
  assert.equal(h.db.all('SELECT * FROM card_message').length, 4);
  assert.equal(listReview(h.ctx).filter((r) => r.kind === 'model_failed').length, 0);
  assert.match(
    JSON.stringify(h.db.all("SELECT after FROM action_log WHERE action='workflow.inferred'")),
    /message assertion/,
  );
  assert.ok(h.calls.some((c) => c.url === 'https://ai-gateway.vercel.sh/typesafe/v1/systemone'));
});

test('follow-up Monday uses evidence timestamp and workflow timezone; buyer ID reference and no-response never complete or archive', {
  timeout: 10000,
}, async (t) => {
  const h = await workflowFixture(t);
  assert.ok(h.ticket);
  await h.deliver('followup');
  await h.app.pipeline.drain();
  let c = getWorkflowTicket(h.ctx, h.ticket.card.id);
  assert.equal(c.followUpAt, '2026-10-18T18:30:00.000Z');
  const p = getDailyPriorities(h.ctx, { at: '2026-10-18T20:00:00Z' });
  assert.equal(p.dueToday.length, 0); // Already completed tickets are excluded from daily priorities.
  await h.deliver('buyer');
  await h.app.pipeline.drain();
  c = getWorkflowTicket(h.ctx, c.card.id);
  assert.equal(c.buyerId, 'customer_123');
  assert.equal(c.workflowStage, 'blocked'); // blocker arrives before buyer in recording
  await h.deliver('noresponse');
  await h.app.pipeline.drain();
  c = getWorkflowTicket(h.ctx, c.card.id);
  assert.equal(c.card.archived, false);
  assert.notEqual(c.workflowStage, 'completed');
});

for (const scenario of ['threshold', 'no-evidence', 'failed-Jev'] as const)
  test(`workflow ${scenario} creates real review and preserves ticket; no OpenAI stage fallback`, {
    timeout: 10000,
  }, async (t) => {
    const h = await workflowFixture(t);
    assert.ok(h.ticket);
    h.policy.confidence = scenario === 'threshold' ? 0.85 : 0.99;
    h.policy.failed = scenario === 'failed-Jev';
    h.policy.missingSupport = scenario === 'no-evidence';
    await h.deliver('two');
    await h.app.pipeline.drain();
    assert.equal(getWorkflowTicket(h.ctx, h.ticket.card.id).workflowStage, 'to_be_started');
    assert.ok(listReview(h.ctx).some((r) => r.kind === 'model_failed'));
    assert.equal(h.db.all('SELECT * FROM card_message').length, 0);
  });

test('explicit human metadata overrides survive automatic updates; stale in-flight Jev response cannot undo human stage edit', {
  timeout: 10000,
}, async (t) => {
  const h = await workflowFixture(t);
  assert.ok(h.ticket);
  let c = updateWorkflowTicket(h.ctx, h.ticket.card.id, {
    version: h.ticket.version,
    workstream: 'provider',
    nextAction: 'Human owner next action',
  });
  await h.deliver('two');
  await h.app.pipeline.drain();
  c = getWorkflowTicket(h.ctx, c.card.id);
  assert.equal(c.workstream, 'provider');
  assert.equal(c.nextAction, 'Human owner next action');
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<Response>();
  const original = h.handlers.movement;
  h.handlers.movement = async (body) => {
    entered.resolve();
    return release.promise.then(() => original(body));
  };
  await h.deliver('three');
  const pending = h.app.pipeline.processNext();
  await entered.promise;
  c = moveWorkflowTicket(h.ctx, c.card.id, { version: c.version, to: 'to_be_started', reason: 'Human reassessment' });
  release.resolve(new Response());
  assert.equal(await pending, null);
  assert.equal(getWorkflowTicket(h.ctx, c.card.id).workflowStage, 'to_be_started');
});

test('workflow inference cancellation retires pipeline immediately and ignores late Jev completion', {
  timeout: 10000,
}, async (t) => {
  const h = await workflowFixture(t);
  assert.ok(h.ticket);
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
  await h.app.pipeline.stop();
  assert.equal(await pending, null);
  release.resolve(new Response());
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(h.db.all('SELECT * FROM decision').length, 0);
  assert.equal(getWorkflowTicket(h.ctx, h.ticket.card.id).workflowStage, 'to_be_started');
});

test('physical withdrawal clears derived workflow fields and copied history', { timeout: 10000 }, async (t) => {
  const h = await workflowFixture(t);
  assert.ok(h.ticket);
  await h.deliver('blocked');
  await h.app.pipeline.drain();
  const c = getWorkflowTicket(h.ctx, h.ticket.card.id);
  assert.equal(c.workflowStage, 'blocked');
  assert.match(c.blockedReason ?? '', /PRIVATE_WORKFLOW_BLOCKER_MARKER/);
  updateWorkflowTicket(h.ctx, c.card.id, { version: c.version, nextAction: 'Human safe action' });
  const account = h.db.get<{ id: number }>('SELECT id FROM channel_account');
  assert.ok(account);
  withdrawChat(h.ctx, h.app.host, account.id, h.chatId);
  assert.equal(h.db.all('SELECT * FROM workflow_field_source WHERE human=0').length, 0);
  assert.doesNotMatch(JSON.stringify(h.db.all('SELECT * FROM workflow_ticket')), /PRIVATE_WORKFLOW_BLOCKER_MARKER/);
  assert.doesNotMatch(JSON.stringify(h.db.all('SELECT * FROM action_log')), /PRIVATE_WORKFLOW_BLOCKER_MARKER/);
  assert.deepEqual(h.db.all('PRAGMA foreign_key_check'), []);
});

test('Jev can create substantive work but arbitrary included outreach produces a real grouped lead suggestion', {
  timeout: 10000,
}, async (t) => {
  const h = await workflowFixture(t, false);
  await h.deliver('one');
  await h.app.pipeline.drain();
  assert.equal(getWorkflowBoard(h.ctx).tickets.length, 0);
  let proposals = listReview(h.ctx).filter((r) => r.kind === 'new_card');
  assert.equal(proposals.length, 1);
  await h.deliver('two');
  await h.app.pipeline.drain();
  proposals = listReview(h.ctx).filter((r) => r.kind === 'new_card');
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0]?.messages.length, 2);
  assert.ok(proposals[0]);
  acceptReview(h.ctx, proposals[0].id);
  assert.equal(getWorkflowBoard(h.ctx).tickets.length, 1);
  await h.deliver('three');
  await h.app.pipeline.drain();
  assert.equal(getWorkflowBoard(h.ctx).tickets.length, 1);
  assert.equal(getWorkflowBoard(h.ctx).tickets[0]?.workflowStage, 'integrations');
});

test('native withdrawal aborts pending workflow Jev before completion and rejects all late effects', {
  timeout: 10000,
}, async (t) => {
  const h = await workflowFixture(t);
  assert.ok(h.ticket);
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
  const account = h.db.get<{ id: number }>('SELECT id FROM channel_account');
  assert.ok(account);
  withdrawChat(h.ctx, h.app.host, account.id, h.chatId);
  assert.equal(await pending, null);
  release.resolve(new Response());
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(h.db.all('SELECT * FROM decision').length, 0);
  assert.equal(getWorkflowTicket(h.ctx, h.ticket.card.id).workflowStage, 'to_be_started');
});

test('withdrawal retains other-chat ticket and human action while erasing ALL generated workflow fields and physical private bytes', {
  timeout: 10000,
}, async (t) => {
  const h = await workflowFixture(t);
  assert.ok(h.ticket);
  await h.deliver('blocked');
  await h.app.pipeline.drain();
  let c = getWorkflowTicket(h.ctx, h.ticket.card.id);
  c = updateWorkflowTicket(h.ctx, c.card.id, { version: c.version, nextAction: 'Human safe action' });
  const account = h.db.get<{ id: number }>('SELECT id FROM channel_account');
  assert.ok(account);
  h.policy.allowOtherContext = true;
  h.app.host.includeChat(h.ctx, account.id, 'other', { company: null, agreedWordingVersion: 1 });
  await h.app.host.settle();
  await h.deliver('retained');
  const retained = h.db.get<{ id: number }>("SELECT id FROM message WHERE message_key='retained'");
  assert.ok(retained);
  attachMessage(h.ctx, retained.id, c.card.id);
  const marker = Buffer.from('PRIVATE_WORKFLOW_BLOCKER_MARKER');
  assert.ok(Buffer.concat([h.path, `${h.path}-wal`].filter(existsSync).map((p) => readFileSync(p))).includes(marker));
  withdrawChat(h.ctx, h.app.host, account.id, h.chatId);
  c = getWorkflowTicket(h.ctx, c.card.id);
  assert.equal(c.nextAction, 'Human safe action');
  assert.equal(c.blockedReason, null);
  assert.equal(c.followUpAt, null);
  assert.equal(c.workstream, 'others');
  assert.equal(c.buyerId, null);
  assert.equal(c.workflowStage, 'to_be_started');
  for (const path of [h.path, `${h.path}-wal`, `${h.path}-shm`].filter(existsSync))
    assert.equal(readFileSync(path).includes(marker), false);
  assert.equal(h.db.all('SELECT * FROM workflow_field_source WHERE human=0').length, 0);
  assert.deepEqual(h.db.all('PRAGMA foreign_key_check'), []);
  await h.deliver('refill');
  await h.app.pipeline.drain();
  c = getWorkflowTicket(h.ctx, c.card.id);
  assert.equal(
    c.workstream,
    'buyer',
    JSON.stringify({
      review: listReview(h.ctx).map((r) => r.reason),
      messages: h.db.all('SELECT id,message_key,version,processed_version FROM message'),
      sources: h.db.all('SELECT * FROM workflow_field_source'),
    }),
  );
  assert.equal(c.nextAction, 'Human safe action');
  assert.equal(c.blockedReason, null);
});
