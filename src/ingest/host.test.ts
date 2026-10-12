import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCredential,
  credentialForToken,
  removeTeammate,
  revokeCredential,
  setSetting,
  signIn,
  signOut,
  teammateForSession,
} from '../auth/index.ts';
import { getBoard } from '../board/index.ts';
import type { Ctx, FixtureLine } from '../contracts/index.ts';
import { ensureIdentity, getContact, setContactCompany } from '../graph/index.ts';
import { history } from '../log/index.ts';
import { accountId, chat, delivery, fixtureApp, includedId, message, setup } from './host/test-support.ts';
import { agreementWording } from './host.ts';
import { getMessages, searchMessages } from './index.ts';

test('R5.1/2 only 3 of 10 selected chats enter actual DB, graph, FTS or action log', async (t) => {
  const keys = Array.from({ length: 10 }, (_, n) => `chat-${n}`);
  const lines = setup(keys).concat(
    keys.map((key, n) =>
      delivery('alice', key, message(n + 1, { text: n < 3 ? `allowed ${n}` : 'UNSELECTED_CONTENT_MARKER' })),
    ),
  );
  const h = await fixtureApp(lines);
  t.after(async () => {
    await h.app.stop();
    h.close();
  });
  const ctx = h.ctxFor('alice');
  const id = accountId(h);
  assert.equal(getMessages(ctx, {}).length, 0);
  for (const key of keys.slice(0, 3)) h.app.host.includeChat(ctx, id, key, { agreedWordingVersion: 1, company: null });
  await h.app.host.settle();
  await h.control.advanceTo('end');
  assert.equal(getMessages(ctx, {}).length, 3);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM chat')?.n, 3);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM identity WHERE contact_id IS NOT NULL')?.n, 1);
  assert.deepEqual(searchMessages(ctx, { text: 'UNSELECTED_CONTENT_MARKER' }), []);
  for (const table of ['message', 'chat', 'contact', 'identity', 'action_log', 'message_version', 'chat_agreement'])
    assert.doesNotMatch(JSON.stringify(h.db.all(`SELECT * FROM ${table}`)), /UNSELECTED_CONTENT_MARKER/);
  assert.equal(h.app.host.chatCounts(ctx).undecidedRecent, 7);
  assert.equal(getBoard(ctx).version, history(ctx, { limit: 1000 })[0]?.id);
});

test('R5.3/R4.3 E5 owner-only methods reject stale/wrong actors; system disconnect follows actual teammate removal', async (t) => {
  const h = await fixtureApp(setup(['selected'], ['alice', 'bob']).concat(delivery('bob', 'selected', message(1))), [
    'alice',
    'bob',
  ]);
  t.after(async () => {
    await h.app.stop();
    h.close();
  });
  const alice = h.ctxFor('alice');
  const bob = h.ctxFor('bob');
  const id = accountId(h, 'bob');
  h.app.host.includeChat(bob, id, 'selected', { agreedWordingVersion: 1, company: null });
  await h.app.host.settle();
  const chatId = includedId(h);
  for (const actor of [
    alice.actor,
    { kind: 'system' },
    { kind: 'agent' },
    { kind: 'credential', id: 99 },
    { kind: 'teammate', id: 99 },
  ] as Ctx['actor'][]) {
    const ctx = { ...alice, actor };
    assert.throws(
      () => h.app.host.includeChat(ctx, id, 'selected', { agreedWordingVersion: 1, company: null }),
      /required/,
    );
    assert.throws(() => h.app.host.excludeChat(ctx, id, 'selected'), /required/);
    assert.throws(() => h.app.host.confirmAgreement(ctx, id, chatId, { agreedWordingVersion: 1 }), /required/);
    assert.throws(() => h.app.host.markWithdrawn(ctx, id, chatId), /required/);
    await assert.rejects(h.app.host.listChats(ctx, id), /required/);
    await assert.rejects(h.app.host.continueLogin(ctx, id, {}), /required/);
    if (actor.kind !== 'system') await assert.rejects(h.app.host.disconnect(ctx, id), /required/);
  }
  const credential = createCredential(alice, { name: 'owner APIs denied', scopeMessages: true });
  const credentialCtx = { ...alice, actor: { kind: 'credential' as const, id: credential.id } };
  for (const method of [() => h.app.host.listAccounts(credentialCtx), () => h.app.host.chatCounts(credentialCtx)])
    assert.throws(method, /required/);
  assert.ok(credentialForToken(h.db, credential.token));
  revokeCredential(alice, credential.id);
  assert.equal(credentialForToken(h.db, credential.token), null);
  assert.throws(() => h.app.host.chatCounts(credentialCtx), /required/);
  const signed = signIn(h.db, 'bob', 'synthetic-password', h.clock.now());
  assert.equal(teammateForSession(h.db, signed.token, h.clock.now()), bob.actor.kind === 'teammate' ? bob.actor.id : 0);
  signOut(h.db, signed.token);
  assert.equal(teammateForSession(h.db, signed.token, h.clock.now()), null);
  const started = h.clock.now().getTime();
  assert.equal(bob.actor.kind, 'teammate');
  await removeTeammate(alice, bob.actor.kind === 'teammate' ? bob.actor.id : 0, (accountId) =>
    h.app.host.disconnect({ ...alice, actor: { kind: 'system' } }, accountId),
  );
  assert.ok(h.clock.now().getTime() - started < 60000);
  assert.deepEqual(
    {
      ...h.db.get<{ state: string; session_sealed: null }>(
        'SELECT state,session_sealed FROM channel_account WHERE id=?',
        id,
      ),
    },
    {
      state: 'removed',
      session_sealed: null,
    },
  );
  const logs = history(alice, { limit: 1000 });
  const remove = logs.find((e) => e.action === 'teammate.remove');
  const disconnect = logs.find((e) => e.action === 'account.disconnect');
  assert.ok(remove && disconnect && remove.id < disconnect.id);
  assert.equal(remove.actor.kind, 'teammate');
  assert.equal(disconnect.actor.kind, 'system');
  assert.throws(() => h.app.host.listAccounts(bob), /Active teammate/);
  await assert.rejects(h.app.host.beginLogin(bob, 'fixture', { acknowledgedNoticeVersion: null }), /Active teammate/);
  await h.control.advanceTo('end');
  assert.equal(getMessages(alice, {}).length, 0);
});

test('R5.4 new event inserts unknown cached chat, owner recent count is honest and unconnected is null', async (t) => {
  const lines = setup([], ['alice', 'bob']).concat(
    { t: 'chat', account: 'alice', chat: chat('late') },
    delivery('alice', 'late', message(1, { text: 'LATE_UNDECIDED_MARKER' })),
  );
  const h = await fixtureApp(lines, ['alice', 'bob']);
  t.after(async () => {
    await h.app.stop();
    h.close();
  });
  const alice = h.ctxFor('alice');
  const bob = h.ctxFor('bob');
  await h.control.advanceTo('end');
  assert.equal(h.app.host.chatCounts(alice).undecidedRecent, 1);
  assert.equal(h.app.host.chatCounts(bob).undecidedRecent, 0);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM chat')?.n, 0);
  const listing = await h.app.host.listChats(alice, accountId(h));
  assert.equal(listing[0]?.title, 'Title late');
  assert.equal(listing[0]?.decision, 'undecided');
  assert.equal(getMessages(alice, {}).length, 0);
  h.clock.advance(8 * 86400000);
  assert.equal(h.app.host.chatCounts(alice).undecidedRecent, 0);
  await h.app.host.stopAll();
  assert.deepEqual(h.app.host.chatCounts(alice), { connected: false, undecidedRecent: null, agreementOutOfDate: 0 });
});

test('R5.5/6 statement exact/default-on/off; exclusion keeps durable history; R18.8 first-message human named company and ID-only include log', async (t) => {
  const h = await fixtureApp(setup(['selected']).concat(delivery('alice', 'selected', message(1))));
  t.after(async () => {
    await h.app.stop();
    h.close();
  });
  const ctx = h.ctxFor('alice');
  const id = accountId(h);
  assert.equal(agreementWording().version, 1);
  assert.equal(
    agreementWording().text,
    "The people in this chat have agreed that its messages may be stored on my team's board, read by my teammates, and analysed by software. I will withdraw the chat if any of them withdraws that agreement, or if someone joins who has not agreed.",
  );
  assert.throws(
    () => h.app.host.includeChat(ctx, id, 'selected', { agreedWordingVersion: null, company: 'Named firm' }),
    /agreement/,
  );
  h.app.host.includeChat(ctx, id, 'selected', { agreedWordingVersion: 1, company: 'Named firm' });
  await h.app.host.settle();
  await h.control.advanceTo('end');
  const row = h.db.get<{ contact_id: number; company_id: number; set_by: string }>('SELECT * FROM contact_company');
  assert.ok(row);
  assert.equal(row.set_by, 'human');
  assert.equal(getContact(ctx, row.contact_id).companies[0]?.id, row.company_id);
  assert.throws(
    () =>
      setContactCompany({ ...ctx, actor: { kind: 'agent' } }, row.contact_id, {
        company: { id: row.company_id },
        evidenceMessageIds: [getMessages(ctx, {})[0]?.id ?? 0],
      }),
    /locked/,
  );
  const include = history(ctx, { action: 'chat.include' })[0];
  assert.ok(include);
  assert.doesNotMatch(JSON.stringify(include), /Named firm|Title selected|content 1/);
  assert.equal((include.after as { companyId: number }).companyId, row.company_id);
  const agreement = h.db.all('SELECT * FROM chat_agreement');
  assert.equal(agreement.length, 1);
  h.app.host.excludeChat(ctx, id, 'selected');
  assert.equal(getMessages(ctx, {}).length, 1);
  assert.deepEqual(h.db.all('SELECT * FROM chat_agreement'), agreement);
  setSetting(ctx, 'require_agreement', false);
  h.app.host.includeChat(ctx, id, 'selected', { agreedWordingVersion: null, company: null });
  await h.app.host.settle();
  assert.deepEqual(h.db.all('SELECT * FROM chat_agreement'), agreement);
});

test('R5.7 new outside group speaker flags both included owners; self/broadcast does not; reconfirm clears owner only', async (t) => {
  const lines: FixtureLine[] = setup(['group', 'broadcast'], ['alice', 'bob']).map((l) =>
    l.t === 'chat' ? { ...l, chat: chat(l.chat.key, l.chat.key === 'group' ? 'group' : 'broadcast') } : l,
  );
  lines.push(
    delivery('alice', 'group', message(1, { sender: { userKey: 'self-alice', displayName: 'alice', handle: null } })),
    delivery('alice', 'broadcast', message(2)),
    delivery('alice', 'group', message(3)),
    delivery('bob', 'group', message(3, { nativeId: 'bob-3' })),
    delivery('alice', 'group', message(4)),
  );
  const h = await fixtureApp(lines, ['alice', 'bob']);
  t.after(async () => {
    await h.app.stop();
    h.close();
  });
  for (const name of ['alice', 'bob'])
    h.app.host.includeChat(h.ctxFor(name), accountId(h, name), 'group', { agreedWordingVersion: 1, company: null });
  h.app.host.includeChat(h.ctxFor('alice'), accountId(h), 'broadcast', { agreedWordingVersion: 1, company: null });
  await h.app.host.settle();
  await h.control.advanceTo('end');
  assert.equal(h.app.host.chatCounts(h.ctxFor('alice')).agreementOutOfDate, 1);
  assert.equal(h.app.host.chatCounts(h.ctxFor('bob')).agreementOutOfDate, 1);
  assert.equal(history(h.ctxFor('alice'), { action: 'chat.agreement_stale' }).length, 2);
  assert.equal(getMessages(h.ctxFor('alice'), {}).length, 4);
  h.app.host.confirmAgreement(h.ctxFor('alice'), accountId(h), includedId(h, 'group'), { agreedWordingVersion: 1 });
  assert.equal(h.app.host.chatCounts(h.ctxFor('alice')).agreementOutOfDate, 0);
  assert.equal(h.app.host.chatCounts(h.ctxFor('bob')).agreementOutOfDate, 1);
  assert.equal(h.db.get<{ n: number }>("SELECT count(*) AS n FROM chat_agreement WHERE kind='confirmed'")?.n, 4);
});

test('R18.1/8 existing outside participant named inclusion upgrades association to human, no self contact', async (t) => {
  const h = await fixtureApp(setup().concat(delivery('alice', 'selected', message(1))));
  t.after(async () => {
    await h.app.stop();
    h.close();
  });
  const ctx = h.ctxFor('alice');
  const id = accountId(h);
  ensureIdentity({ ...ctx, actor: { kind: 'system' } }, { channel: 'fixture', ...message(1).sender });
  h.app.host.includeChat(ctx, id, 'selected', { agreedWordingVersion: 1, company: null });
  await h.app.host.settle();
  await h.control.advanceTo('end');
  h.app.host.excludeChat(ctx, id, 'selected');
  h.app.host.includeChat(ctx, id, 'selected', { agreedWordingVersion: 1, company: 'Existing contact firm' });
  assert.equal(h.db.get<{ set_by: string }>('SELECT set_by FROM contact_company')?.set_by, 'human');
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM contact')?.n, 1);
  assert.equal(getMessages(ctx, {})[0]?.sender.contactId, h.db.get<{ id: number }>('SELECT id FROM contact')?.id);
  await h.app.host.settle();
});
