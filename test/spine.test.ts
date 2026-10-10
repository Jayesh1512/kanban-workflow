import assert from 'node:assert/strict';
import test from 'node:test';
import { getSetting } from '../src/auth/index.ts';
import { createLane, getBoard } from '../src/board/index.ts';
import type { CompanyView } from '../src/contracts/index.ts';
import { ensureCompany, setContactCompany, setContactRole } from '../src/graph/index.ts';
import { history } from '../src/log/index.ts';
import { spineRecording, spineScript } from './fixtures/spine.ts';
import { testApp } from './harness.ts';
import { attr, boardCards } from './html.ts';

test('F1 twelve-message empty-DB threshold1 proposal -> named HTTP acceptance -> board HTML -> actual MCP contacts/roles', async (t) => {
  const h = await testApp({
    lines: spineRecording(),
    script: spineScript(),
    movementReplay: [
      {
        messageKey: 'm-1',
        version: 1,
        subjectKey: 'new:m-1',
        answer: { destination: 'stay', evidenceMessageKeys: ['m-1'], confidence: 1, supportConfidence: 1 },
      },
    ],
    teammates: [{ username: 'alice', account: 'alice' }],
  });
  t.after(async () => {
    await h.app.stop();
    h.close();
  });
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM message')?.n, 0);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM card')?.n, 0);
  assert.equal(getSetting(h.db, 'review_threshold'), 1);
  const ctx = h.ctxFor('alice');
  createLane(ctx, {
    name: 'Sales',
    sop: 'Handle client integration requests',
    stages: [
      { name: 'New', criteria: '' },
      { name: 'Delivered', criteria: 'Client confirms delivery' },
    ],
  });
  createLane(ctx, {
    name: 'Finance',
    sop: 'Handle billing requests',
    stages: [
      { name: 'Received', criteria: '' },
      { name: 'Paid', criteria: 'Payment confirmed' },
    ],
  });
  await h.control.advanceTo('setup');
  await h.app.start();
  const account = h.db.get<{ id: number }>('SELECT id FROM channel_account')?.id;
  assert.ok(account);
  const listing = await h.app.host.listChats(ctx, account);
  assert.equal(listing.length, 2);
  assert.throws(
    () => h.app.host.includeChat(ctx, account, 'client', { agreedWordingVersion: null, company: null }),
    /agreement/,
  );
  h.app.host.includeChat(ctx, account, 'client', { agreedWordingVersion: 1, company: null });
  await h.app.host.settle();
  assert.equal(h.db.get<{ sync_state: string }>('SELECT sync_state FROM account_chat')?.sync_state, 'idle');
  await h.control.advanceTo('delivered');
  await h.settle();
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM message')?.n, 12);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM decision')?.n, 12);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM message WHERE processed_version=version')?.n, 12);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM contact')?.n, 2);
  assert.equal(getBoard(ctx).lanes[0]?.cards.length, 0);
  const review = h.db.get<{ id: number; proposal: string }>(
    "SELECT id,proposal FROM review_item WHERE kind='new_card' AND status='open'",
  );
  assert.ok(review);
  assert.equal(
    h.db.get<{ n: number }>('SELECT count(*) AS n FROM review_message WHERE review_item_id=?', review.id)?.n,
    12,
  );
  const loginPage = await h.get('/login');
  assert.equal(loginPage.status, 200);
  const login = await h.post('/login', { username: 'alice', password: 'synthetic-password' });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  assert.match(login.headers.get('set-cookie') ?? '', /HttpOnly/);
  const before = await h.get('/board', { cookie });
  const beforeHtml = await before.text();
  assert.equal(before.status, 200);
  assert.deepEqual(boardCards(beforeHtml), []);
  assert.equal(attr(beforeHtml, 'status', 'automatic-off'), '1');
  const acceptance = await h.post(`/review/${review.id}/accept`, {}, { cookie });
  assert.equal(acceptance.status, 303);
  const board = await h.get('/board', { cookie });
  const markup = await board.text();
  const cards = boardCards(markup);
  assert.deepEqual(cards, [
    { cardId: cards[0]?.cardId, laneName: 'Sales', stageName: 'New', title: 'Acme <integration>' },
  ]);
  assert.match(markup, /Acme &lt;integration&gt;/);
  assert.equal(attr(markup, 'status', 'automatic-off'), '1');
  assert.equal(getSetting(h.db, 'review_threshold'), 1);
  assert.equal(h.app.pipeline.status().movement.execution, 'replay');
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM card_message WHERE set_by=?', 'human')?.n, 12);
  assert.equal(history(ctx, { action: 'review.accept' }).length, 1);
  assert.equal(history(ctx, { action: 'review.accept' })[0]?.actor.name, 'alice');
  assert.equal((await h.post(`/review/${review.id}/accept`, {}, { cookie })).status, 409);
  const companyId = ensureCompany(ctx, 'Acme');
  const bob = h.db.get<{ id: number }>(
    'SELECT c.id FROM contact c JOIN identity i ON i.contact_id=c.id WHERE i.user_key=?',
    'u-bob',
  )?.id;
  const dana = h.db.get<{ id: number }>(
    'SELECT c.id FROM contact c JOIN identity i ON i.contact_id=c.id WHERE i.user_key=?',
    'u-dana',
  )?.id;
  assert.ok(bob);
  assert.ok(dana);
  for (const [id, key, category, about] of [
    [bob, 'm-1', 'technical', 'system integration'],
    [dana, 'm-7', 'finance', 'invoices'],
  ] as const) {
    const evidence = h.db.get<{ id: number }>('SELECT id FROM message WHERE message_key=?', key)?.id;
    assert.ok(evidence);
    setContactCompany(ctx, id, { company: { id: companyId }, evidenceMessageIds: [evidence] });
    setContactRole(ctx, id, { category, dealsAbout: about, evidenceMessageIds: [evidence] });
  }
  const token = h.tokenFor({ name: 'spine reader', scopeMessages: false });
  const company = (await h.mcp('get_company', { companyId }, token)) as CompanyView;
  assert.equal(company.name, 'Acme');
  assert.deepEqual(
    company.contacts.map((c) => [c.name, c.roleCategory, c.dealsAbout]),
    [
      ['Bob', 'technical', 'system integration'],
      ['Dana', 'finance', 'invoices'],
    ],
  );
  assert.equal(company.recentMessages.length, 12);
  assert.ok(company.recentMessages.every((m) => m.text === null));
  assert.equal(company.lastConversationAt, '2026-09-01T10:00:12.000Z');
  assert.equal(history(ctx, { action: 'mcp.call' }).length, 1);
  assert.equal(await h.app.pipeline.processNext(), null);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM decision')?.n, 12);
});
