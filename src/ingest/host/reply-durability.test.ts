import assert from 'node:assert/strict';
import test from 'node:test';
import type { Id, MessageRecord } from '../../contracts/index.ts';
import { deleteMessages, getMessages } from '../index.ts';
import { type DurabilityRig, durabilityRig } from './durability-support.ts';
import { resolveReplies } from './replies.ts';
import type { Account } from './state.ts';
import { storeOnce } from './store-once.ts';
import { chat, message } from './test-support.ts';

async function emit(r: DurabilityRig, name: string, m: MessageRecord, key = 'selected') {
  await r.sinks.get(r.accounts.get(name) ?? 0)?.emit({ type: 'message', chat: chat(key), message: m });
}
function pending(r: DurabilityRig) {
  return r.db.all('SELECT * FROM message_sighting ORDER BY account_id,message_id');
}
function snapshot(r: DurabilityRig) {
  return ['message', 'message_sighting', 'identity', 'contact', 'chat_participant', 'action_log'].map((table) =>
    r.db.all(`SELECT * FROM ${table} ORDER BY rowid`),
  );
}
function account(r: DurabilityRig, name: string) {
  const a = r.db.get<Account>('SELECT * FROM channel_account WHERE id=?', r.accounts.get(name) ?? 0);
  assert.ok(a);
  return a;
}

test('durable replies: live→history/history→live, duplicate-only target, cross-account/native/chat namespace and #2 remain exact', async (t) => {
  let page: MessageRecord[] = [];
  let cursor: string | null = null;
  let historyAccount: Id | null = null;
  const r = await durabilityRig({
    keys: ['selected', 'other'],
    decorate(c, cctx) {
      return {
        ...c,
        async listChats() {
          return (await c.listChats()).map((e) => ({ ...e, latestAt: message(1000).sentAt, latestCursor: cursor }));
        },
        async *fetchHistory() {
          yield { messages: cctx.accountId === historyAccount ? page : [], resume: null };
        },
      };
    },
  });
  t.after(() => r.close());
  historyAccount = r.accounts.get('alice') ?? null;
  for (const name of ['alice', 'bob']) for (const key of ['selected', 'other']) r.include(name, key);
  await r.host.settle();
  await emit(r, 'alice', message(3, { replyToNativeId: 'native-2' }));
  // Other account AND other chat lookalikes must not resolve Alice's namespace.
  await emit(r, 'bob', message(2));
  await emit(r, 'alice', message(20, { nativeId: 'native-2' }), 'other');
  assert.equal(
    getMessages(r.ctx(), { chatId: r.chatId() }).find((m) => m.sentAt === message(3).sentAt)?.replyToId,
    null,
  );
  // native-first means that a reused native ID in the other chat remains there.
  page = [message(2, { nativeId: 'alice-target' })];
  await emit(r, 'alice', message(4, { replyToNativeId: 'alice-target' }));
  cursor = 'opaque-history-a';
  await r.host.stopAll();
  await r.host.startAll();
  await r.host.settle();
  const target = getMessages(r.ctx(), { chatId: r.chatId() }).find((m) => m.sentAt === message(2).sentAt);
  assert.ok(target);
  assert.equal(
    getMessages(r.ctx(), { chatId: r.chatId() }).find((m) => m.sentAt === message(4).sentAt)?.replyToId,
    target.id,
  );
  page = [message(6, { replyToNativeId: 'future-live' })];
  cursor = 'opaque-history-b';
  await r.host.stopAll();
  await r.host.startAll();
  await r.host.settle();
  await emit(r, 'alice', message(5, { nativeId: 'future-live', key: 'key-2' }));
  const collision = r.db.get<{ id: Id; message_key: string }>(
    "SELECT id,message_key FROM message WHERE message_key='key-2#2'",
  );
  assert.ok(collision);
  assert.equal(getMessages(r.ctx(), {}).find((m) => m.sentAt === message(6).sentAt)?.replyToId, collision.id);
  // Persisted pending plus an already retained target: a duplicate-only history page still resolves.
  await emit(r, 'alice', message(8, { replyToNativeId: 'duplicate-target' }));
  r.db.tx(() =>
    storeOnce(r.system, account(r, 'alice'), r.chatId(), message(7, { nativeId: 'duplicate-target' }), 'history'),
  );
  const before = r.db.get<{ n: number }>('SELECT count(*) AS n FROM message')?.n;
  page = [message(7, { nativeId: 'duplicate-target', text: 'DUPLICATE_MARKER_MUST_NOT_STORE' })];
  cursor = 'opaque-history-c';
  await r.host.stopAll();
  await r.host.startAll();
  await r.host.settle();
  assert.equal(r.db.get<{ n: number }>('SELECT count(*) AS n FROM message')?.n, before);
  const views = getMessages(r.ctx(), {});
  assert.equal(
    views.find((m) => m.sentAt === message(8).sentAt)?.replyToId,
    views.find((m) => m.sentAt === message(7).sentAt)?.id,
  );
  assert.doesNotMatch(JSON.stringify(snapshot(r)), /DUPLICATE_MARKER/);
});

test('ALL cross-sighting candidates checked before clear: agreeing targets link, conflict/self/existing-link never overwrite and roll back', async (t) => {
  const r = await durabilityRig({ names: ['alice', 'bob', 'charlie'] });
  t.after(() => r.close());
  for (const name of ['alice', 'bob', 'charlie']) r.include(name);
  await r.host.settle();
  await emit(r, 'alice', message(10, { replyToNativeId: 'a-target' }));
  await emit(r, 'bob', message(10, { nativeId: 'bob-source', replyToNativeId: 'b-target' }));
  const before = snapshot(r);
  assert.throws(
    () =>
      r.db.tx(() => {
        storeOnce(r.system, account(r, 'alice'), r.chatId(), message(1, { nativeId: 'a-target' }), 'history');
        storeOnce(r.system, account(r, 'bob'), r.chatId(), message(2, { nativeId: 'b-target' }), 'history');
        resolveReplies(r.system, r.chatId());
      }),
    /Stored reply conflicts/,
  );
  assert.deepEqual(snapshot(r), before);
  r.db.tx(() => {
    storeOnce(r.system, account(r, 'alice'), r.chatId(), message(1, { nativeId: 'a-target' }), 'history');
    storeOnce(r.system, account(r, 'bob'), r.chatId(), message(1, { nativeId: 'b-target' }), 'history');
    resolveReplies(r.system, r.chatId());
  });
  const linked = getMessages(r.ctx(), {}).find((m) => m.sentAt === message(10).sentAt);
  assert.ok(linked?.replyToId);
  assert.equal(
    r.db.get<{ n: number }>('SELECT count(*) AS n FROM message_sighting WHERE reply_to_native_id IS NOT NULL')?.n,
    0,
  );
  // NEW sighting behind an existing link must validate an immediate disagreeing candidate.
  await emit(r, 'charlie', message(2));
  const a = account(r, 'charlie');
  const frozen = snapshot(r);
  assert.throws(
    () =>
      storeOnce(
        r.system,
        a,
        r.chatId(),
        message(10, { nativeId: 'new-source-sighting', replyToNativeId: 'native-2' }),
        'history',
      ),
    /Stored reply conflicts/,
  );
  assert.deepEqual(snapshot(r), frozen);
  await assert.rejects(emit(r, 'alice', message(30, { replyToNativeId: 'native-30' })), /Stored reply conflicts/);
  assert.deepEqual(snapshot(r), frozen);
});

test('unresolved alternative/empty ref discard, duplicate non-reconstruction, lifecycle scope, cascade and target SET NULL', async (t) => {
  const r = await durabilityRig({ keys: ['selected', 'other'] });
  t.after(() => r.close());
  for (const name of ['alice', 'bob']) for (const key of ['selected', 'other']) r.include(name, key);
  await r.host.settle();
  await emit(r, 'alice', message(9, { replyToNativeId: 'a-target' }));
  await emit(r, 'bob', message(9, { nativeId: 'bob-source', replyToNativeId: 'b-alternative' }));
  await emit(r, 'alice', message(1, { nativeId: 'a-target' }));
  assert.equal(
    r.db.get<{ n: number }>('SELECT count(*) AS n FROM message_sighting WHERE reply_to_native_id IS NOT NULL')?.n,
    0,
  );
  await emit(r, 'bob', message(9, { nativeId: 'bob-source', replyToNativeId: 'b-alternative' }));
  await emit(r, 'bob', message(2, { nativeId: 'b-alternative' }));
  const source = getMessages(r.ctx(), {}).find((m) => m.sentAt === message(9).sentAt);
  assert.ok(source?.replyToId);
  deleteMessages(r.system, [source.replyToId]);
  assert.equal(getMessages(r.ctx(), {}).find((m) => m.id === source.id)?.replyToId, null);
  await emit(r, 'bob', message(9, { nativeId: 'bob-source', replyToNativeId: 'b-alternative' }));
  assert.equal(getMessages(r.ctx(), {}).find((m) => m.id === source.id)?.replyToId, null);
  await emit(r, 'alice', message(40, { replyToNativeId: '' }));
  await emit(r, 'bob', message(40, { nativeId: 'bob-40', replyToNativeId: 'never' }));
  await emit(r, 'alice', message(41, { replyToNativeId: 'never-other' }), 'other');
  const empty = r.db.get<{ reply_to_native_id: string }>(
    'SELECT reply_to_native_id FROM message_sighting WHERE native_id=?',
    'native-40',
  );
  assert.equal(empty?.reply_to_native_id, '');
  r.host.excludeChat(r.ctx(), r.accounts.get('alice') ?? 0, 'selected');
  assert.equal(
    r.db.get<{ reply_to_native_id: string | null }>(
      'SELECT reply_to_native_id FROM message_sighting WHERE native_id=?',
      'native-40',
    )?.reply_to_native_id,
    null,
  );
  assert.equal(
    r.db.get<{ reply_to_native_id: string }>(
      'SELECT reply_to_native_id FROM message_sighting WHERE native_id=?',
      'bob-40',
    )?.reply_to_native_id,
    'never',
  );
  r.include();
  await r.host.settle();
  await emit(r, 'alice', message(40, { replyToNativeId: 'resurrect-marker' }));
  assert.doesNotMatch(JSON.stringify(pending(r)), /resurrect-marker/);
  await r.host.disconnect(r.ctx(), r.accounts.get('alice') ?? 0);
  assert.equal(
    r.db.get<{ n: number }>(
      'SELECT count(*) AS n FROM message_sighting WHERE account_id=? AND reply_to_native_id IS NOT NULL',
      r.accounts.get('alice') ?? 0,
    )?.n,
    0,
  );
  const bsource = getMessages(r.ctx(), {}).find((m) => m.sentAt === message(40).sentAt);
  assert.ok(bsource);
  deleteMessages(r.system, [bsource.id]);
  assert.equal(
    r.db.get<{ n: number }>('SELECT count(*) AS n FROM message_sighting WHERE message_id=?', bsource.id)?.n,
    0,
  );
  await emit(r, 'bob', message(45, { replyToNativeId: 'withdraw-marker' }));
  r.db.tx(() => r.host.markWithdrawn(r.ctx('bob'), r.accounts.get('bob') ?? 0, r.chatId()));
  assert.equal(
    r.db.get<{ n: number }>('SELECT count(*) AS n FROM message_sighting WHERE reply_to_native_id IS NOT NULL')?.n,
    0,
  );
});

test('excluded/undecided/withdrawn gated reply markers never enter storage/graph/FTS/log', async (t) => {
  const r = await durabilityRig({ keys: ['selected', 'excluded', 'undecided'] });
  t.after(() => r.close());
  r.include();
  await r.host.settle();
  r.host.excludeChat(r.ctx(), r.accounts.get('alice') ?? 0, 'excluded');
  for (const key of ['excluded', 'undecided'])
    await emit(
      r,
      'alice',
      message(50, {
        text: 'GATED_CONTENT_MARKER',
        replyToNativeId: 'GATED_NATIVE_MARKER',
        sender: { userKey: 'GATED_USER_MARKER', displayName: 'GATED_NAME_MARKER', handle: null },
      }),
      key,
    );
  assert.doesNotMatch(JSON.stringify(snapshot(r)), /GATED_/);
  assert.equal(
    r.db.get<{ n: number }>("SELECT count(*) AS n FROM message_fts WHERE message_fts MATCH 'GATED_CONTENT_MARKER'")?.n,
    0,
  );
  r.db.tx(() => r.host.markWithdrawn(r.ctx(), r.accounts.get('alice') ?? 0, r.chatId()));
  await emit(r, 'alice', message(51, { text: 'WITHDRAWN_MARKER', replyToNativeId: 'WITHDRAWN_REF' }));
  assert.doesNotMatch(JSON.stringify(snapshot(r)), /WITHDRAWN_MARKER|WITHDRAWN_REF/);
});
