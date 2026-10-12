import assert from 'node:assert/strict';
import test from 'node:test';
import type { FixtureLine } from '../../contracts/index.ts';
import { history } from '../../log/index.ts';
import { getMessages } from '../index.ts';
import { accountId, chat, deferred, delivery, fixtureApp, includedId, message, setup } from './test-support.ts';

test('R6.1/3 sighting first, duplicate delivery, cross-account logical messages, lowest-free collision suffix, sender/reply intact', async (t) => {
  const lines: FixtureLine[] = setup(['shared'], ['alice', 'bob']).map((l) =>
    l.t === 'chat' ? { ...l, chat: chat('shared', 'group') } : l,
  );
  for (let n = 1; n <= 20; n++)
    for (const account of ['alice', 'bob'])
      for (let duplicate = 0; duplicate < 2; duplicate++)
        lines.push(
          delivery(
            account,
            'shared',
            message(n, {
              nativeId: `${account}-${n}`,
              sender: n === 1 ? { userKey: 'self-alice', displayName: 'alice', handle: null } : message(n).sender,
              replyToNativeId: n === 2 ? `${account}-1` : null,
            }),
          ),
        );
  lines.push(
    delivery('alice', 'shared', message(21, { key: 'key-20' })),
    delivery('alice', 'shared', message(22, { key: 'key-20' })),
  );
  const h = await fixtureApp(lines, ['alice', 'bob']);
  t.after(async () => {
    await h.app.stop();
    h.close();
  });
  for (const name of ['alice', 'bob'])
    h.app.host.includeChat(h.ctxFor(name), accountId(h, name), 'shared', { agreedWordingVersion: 1, company: null });
  await h.app.host.settle();
  await h.control.advanceTo('end');
  const messages = getMessages(h.ctxFor('alice'), {});
  assert.equal(messages.length, 22);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM message_sighting')?.n, 42);
  assert.deepEqual(
    h.db
      .all<{ message_key: string }>(
        "SELECT message_key FROM message WHERE message_key LIKE 'key-20%' ORDER BY message_key",
      )
      .map((r) => r.message_key),
    ['key-20', 'key-20#2', 'key-20#3'],
  );
  const first = messages.find((m) => m.sentAt === message(1).sentAt);
  const reply = messages.find((m) => m.sentAt === message(2).sentAt);
  assert.equal(first?.direction, 'out');
  assert.equal(first?.sender.contactId, null);
  assert.equal(reply?.direction, 'in');
  assert.equal(reply?.replyToId, first?.id);
  assert.equal(reply?.teammateIds.length, 2);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM contact')?.n, 1);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM decision')?.n, 0); // Full order/reprocessing belongs A1.
});

test('R5.8 inclusion uses last seven days and max 200; newest-first history resolves reply edges across pages', async (t) => {
  const base = Date.parse('2026-09-01T10:00:00.000Z');
  const selected = Array.from({ length: 12 }, (_, n) =>
    message(n + 1, {
      sentAt: new Date(base - (11 - n) * 86400000).toISOString(),
      replyToNativeId: n === 11 ? 'native-11' : null,
    }),
  );
  const lines: FixtureLine[] = [
    { t: 'config', pageSize: 1 },
    ...setup(['selected', 'cap']),
    ...selected.map((m) => delivery('alice', 'selected', m, 'history')),
    ...Array.from({ length: 205 }, (_, n) =>
      delivery('alice', 'cap', message(1000 + n, { sentAt: new Date(base - 1000 + n).toISOString() }), 'history'),
    ),
    { t: 'mark', name: 'loaded' },
  ];
  const h = await fixtureApp(lines);
  t.after(async () => {
    await h.app.stop();
    h.close();
  });
  await h.control.advanceTo('loaded');
  await h.app.host.listChats(h.ctxFor('alice'), accountId(h));
  for (const key of ['selected', 'cap'])
    h.app.host.includeChat(h.ctxFor('alice'), accountId(h), key, { agreedWordingVersion: 1, company: null });
  await h.app.host.settle();
  const recent = getMessages(h.ctxFor('alice'), { chatId: includedId(h), limit: 200 });
  assert.deepEqual(
    recent.map((m) => m.sentAt).reverse(),
    selected.filter((m) => m.sentAt >= new Date(base - 7 * 86400000).toISOString()).map((m) => m.sentAt),
  );
  assert.equal(recent[0]?.replyToId, recent[1]?.id);
  assert.equal(getMessages(h.ctxFor('alice'), { chatId: includedId(h, 'cap'), limit: 300 }).length, 200);
});

test('R6.2 file-backed testApp restart catches 50 missed messages once and lists once', async (t) => {
  const lines = setup().concat(
    { t: 'mark', name: 'before-stop' },
    Array.from({ length: 50 }, (_, n) => delivery('alice', 'selected', message(n + 1), 'missed')),
    { t: 'mark', name: 'missed' },
  );
  const h = await fixtureApp(lines);
  t.after(async () => {
    await h.app.stop();
    h.close();
  });
  h.app.host.includeChat(h.ctxFor('alice'), accountId(h), 'selected', { agreedWordingVersion: 1, company: null });
  await h.app.host.settle();
  await h.control.advanceTo('before-stop');
  await h.app.stop();
  await h.control.advanceTo('missed');
  const before = h.control.calls.length;
  const at = h.clock.now().getTime();
  await h.restart();
  await h.app.host.settle();
  assert.ok(h.clock.now().getTime() - at < 600000);
  assert.equal(h.control.calls.slice(before).filter((c) => c.op === 'listChats').length, 1);
  assert.equal(h.control.calls.slice(before).filter((c) => c.op === 'fetchHistory').length, 1);
  assert.deepEqual(
    getMessages(h.ctxFor('alice'), { limit: 100 })
      .map((m) => m.sentAt)
      .reverse(),
    Array.from({ length: 50 }, (_, n) => message(n + 1).sentAt),
  );
  await h.app.host.startAll();
  assert.equal(h.control.calls.slice(before).filter((c) => c.op === 'fetchHistory').length, 1);
});

test('R6.5 E3 retained page/resume/newest/after/since/limit survive real file reopen; live cursor does not requeue/replace kept work', async (t) => {
  const lines: FixtureLine[] = [
    { t: 'config', pageSize: 2 },
    ...setup(),
    ...Array.from({ length: 6 }, (_, n) => delivery('alice', 'selected', message(n + 1), 'history')),
    { t: 'history_error', account: 'alice', chatKey: 'selected', afterPages: 1, times: 1 },
    { t: 'mark', name: 'loaded' },
    delivery('alice', 'selected', message(9)),
    { t: 'mark', name: 'new-live' },
  ];
  const h = await fixtureApp(lines);
  t.after(async () => {
    await h.app.stop();
    h.close();
  });
  await h.control.advanceTo('loaded');
  await h.app.pipeline.stop();
  await h.app.host.listChats(h.ctxFor('alice'), accountId(h));
  const failed = deferred();
  const run = h.db.run.bind(h.db);
  h.db.run = (sql, ...params) => {
    const result = run(sql, ...params);
    if (sql.includes("sync_state='failed'")) failed.resolve();
    return result;
  };
  h.app.host.includeChat(h.ctxFor('alice'), accountId(h), 'selected', { agreedWordingVersion: 1, company: null });
  await failed.promise;
  const original = h.db.get<{
    sync_after: string | null;
    sync_since: string;
    sync_limit: number;
    sync_resume: string;
    sync_newest: string;
  }>('SELECT * FROM account_chat');
  assert.ok(original);
  assert.equal(getMessages(h.ctxFor('alice'), {}).length, 2);
  assert.ok(original.sync_resume);
  assert.equal(original.sync_newest, message(6).cursor);
  assert.equal(h.app.host.listAccounts(h.ctxFor('alice'))[0]?.gaps.length, 1);
  assert.equal(await h.app.pipeline.processNext(), null);
  const before = h.control.calls.length;
  await h.restart();
  const retained = h.db.get<typeof original>('SELECT * FROM account_chat');
  assert.equal(retained?.sync_after, original.sync_after);
  assert.equal(retained?.sync_since, original.sync_since);
  assert.equal(retained?.sync_limit, original.sync_limit);
  assert.equal(retained?.sync_resume, original.sync_resume);
  assert.equal(retained?.sync_newest, original.sync_newest);
  assert.equal(h.app.host.listAccounts(h.ctxFor('alice'))[0]?.gaps.length, 1);
  await h.control.advanceTo('new-live');
  await h.app.host.startAll();
  await h.app.host.settle();
  assert.equal(getMessages(h.ctxFor('alice'), {}).length, 7);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM message_sighting')?.n, 7);
  assert.equal(
    h.db.get<{ live_cursor: string }>('SELECT live_cursor FROM account_chat')?.live_cursor,
    message(9).cursor,
  );
  assert.equal(h.control.calls.slice(before).filter((c) => c.op === 'fetchHistory').length, 2);
  assert.equal(h.control.calls.slice(before).filter((c) => c.op === 'listChats').length, 1);
  assert.equal(h.app.host.listAccounts(h.ctxFor('alice'))[0]?.gaps.length, 0);
  assert.equal(history(h.ctxFor('alice'), { action: 'chat.gap_close' }).length, 1);
});
