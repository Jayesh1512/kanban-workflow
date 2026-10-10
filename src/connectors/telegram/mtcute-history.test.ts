import assert from 'node:assert/strict';
import test from 'node:test';
import { type tl, User } from '@mtcute/node';
import { testContext } from '../test-support.ts';
import { createTelegramFactory } from './connector.ts';
import { MtcuteApi } from './mtcute-api.ts';
import { createMtcuteClient } from './mtcute-client.ts';
import { sdkData } from './mtcute-test-data.ts';
import { blockedTransport, offlineContext } from './mtcute-test-support.ts';
import { pages } from './test-session.ts';

test('Actual raw adapter pages 300 dialogs with service-only cursor: 53 paced reads and three when none missed', async (t) => {
  const state = offlineContext();
  const clock = testContext();
  state.ctx.now = clock.ctx.now;
  const deadline = state.ctx.sleep;
  state.ctx.sleep = (ms) => (ms === 5000 ? deadline(ms) : clock.ctx.sleep(ms));
  const data = sdkData();
  const client = createMtcuteClient(state.ctx, blockedTransport);
  t.mock.method(client.sdk, 'getMe', async () => new User(data.users[0] as tl.RawUser));
  t.mock.method(client.sdk, 'importSession', async () => {});
  const chats: tl.TypeChat[] = Array.from({ length: 300 }, (_, n) => ({
    ...(data.chats[0] as tl.RawChat),
    id: 1000 + n,
    title: `Synthetic ${n}`,
  }));
  const dialogs: tl.RawDialog[] = chats.map((chat, n) => ({
    ...(data.dialogs[1] as tl.RawDialog),
    peer: { _: 'peerChat', chatId: chat.id },
    topMessage: n + 1,
  }));
  const messages: tl.RawMessageService[] = dialogs.map((dialog, n) => ({
    _: 'messageService',
    peerId: dialog.peer,
    fromId: { _: 'peerUser', userId: 20 },
    id: n + 1,
    date: 1800000300 - n,
    action: { _: 'messageActionPinMessage' },
  }));
  const calls: { op: string; at: number }[] = [];
  client.dialogs = async (request) => {
    calls.push({ op: request._, at: state.ctx.now().getTime() });
    const offset = request.offsetPeer._ === 'inputPeerChat' ? request.offsetPeer.chatId - 999 : 0;
    assert.equal(request.excludePinned, offset !== 0);
    assert.equal(request.limit, 100);
    if (offset) assert.equal(request.offsetDate, messages[offset - 1]?.date);
    return {
      _: 'messages.dialogsSlice',
      count: 300,
      dialogs: dialogs.slice(offset, offset + 100),
      messages: messages.slice(offset, offset + 100),
      chats: chats.slice(offset, offset + 100),
      users: data.users,
    };
  };
  client.history = async (request) => {
    calls.push({ op: request._, at: state.ctx.now().getTime() });
    assert.equal(request.peer._, 'inputPeerChat');
    assert.ok(request.limit <= 100);
    const n = request.peer._ === 'inputPeerChat' ? request.peer.chatId - 1000 : -1;
    assert.ok(n >= 0 && n < 50);
    return {
      _: 'messages.messages',
      topics: [],
      messages: [messages[n] as tl.TypeMessage],
      chats: [chats[n] as tl.TypeChat],
      users: data.users,
    };
  };
  const api = new MtcuteApi(state.ctx, () => client);
  const connector = createTelegramFactory(() => api).create({ ...state.ctx, session: 'synthetic-opaque' });
  const listed = await connector.listChats();
  assert.equal(listed.length, 300);
  assert.equal(listed[0]?.latestCursor, '1');
  assert.equal(listed[0]?.latestAt, new Date(1800000300 * 1000).toISOString());
  for (const entry of listed.slice(0, 50)) {
    const result = await pages(connector, { chat: entry.chat, after: null, since: null, limit: null, resume: null });
    assert.deepEqual(result, [{ messages: [], resume: null }]);
  }
  assert.equal(calls.length, 53);
  assert.equal(calls.filter((c) => c.op === 'messages.getDialogs').length, 3);
  for (let n = 1; n < calls.length; n++) assert.ok((calls[n]?.at ?? 0) - (calls[n - 1]?.at ?? 0) >= 3000);
  calls.length = 0;
  const stored = new Map(listed.map((entry) => [entry.chat.key, entry.latestCursor]));
  for (const entry of await connector.listChats()) {
    if (stored.get(entry.chat.key) !== entry.latestCursor) assert.fail('Unexpected missed-chat fetch');
  }
  assert.deepEqual(
    calls.map((c) => c.op),
    Array(3).fill('messages.getDialogs'),
  );
  await api.destroy();
});

test('Actual raw history interruption preserves yielded page and query-bound resume; empty raw holes fail visibly', async (t) => {
  const state = offlineContext();
  const clock = testContext();
  state.ctx.now = clock.ctx.now;
  const deadline = state.ctx.sleep;
  state.ctx.sleep = (ms) => (ms === 5000 ? deadline(ms) : clock.ctx.sleep(ms));
  const data = sdkData();
  const client = createMtcuteClient(state.ctx, blockedTransport);
  t.mock.method(client.sdk, 'getMe', async () => new User(data.users[0] as tl.RawUser));
  t.mock.method(client.sdk, 'importSession', async () => {});
  client.dialogs = async () => ({
    _: 'messages.dialogs',
    dialogs: [data.dialogs[0] as tl.RawDialog],
    messages: [],
    chats: [],
    users: data.users,
  });
  const raw = data.messages.map((m) => ({ ...m, peerId: data.peers[0] as tl.TypePeer }));
  const offsets: number[] = [];
  let fail = true;
  client.history = async (request) => {
    offsets.push(request.maxId);
    if (request.maxId && fail) {
      fail = false;
      throw new Error('Synthetic error after first page');
    }
    return {
      _: 'messages.messages',
      topics: [],
      users: data.users,
      chats: [],
      messages: raw
        .filter((m) => m.id > request.minId && (!request.maxId || m.id < request.maxId))
        .toReversed()
        .slice(0, request.limit),
    };
  };
  const api = new MtcuteApi(state.ctx, () => client);
  const connector = createTelegramFactory(() => api).create({ ...state.ctx, session: 'synthetic-opaque' });
  const entry = (await connector.listChats())[0];
  assert.ok(entry);
  const req = { chat: entry.chat, after: null, since: null, limit: null, resume: null };
  const iterator = connector.fetchHistory(req)[Symbol.asyncIterator]();
  const page = (await iterator.next()).value;
  assert.ok(page?.resume);
  assert.equal(page.messages.length, 100);
  await assert.rejects(iterator.next(), /Synthetic error after first page/);
  await assert.rejects(pages(connector, { ...req, after: '1', resume: page.resume }), /resume/i);
  const rest = await pages(connector, { ...req, resume: page.resume });
  assert.deepEqual(
    [...page.messages, ...rest.flatMap((p) => p.messages)].map((m) => m.cursor),
    Array.from({ length: 220 }, (_, n) => String(220 - n)),
  );
  assert.deepEqual(offsets, [0, 121, 121, 21]);
  client.history = async () => ({
    _: 'messages.messages',
    topics: [],
    users: [],
    chats: [],
    messages: [{ _: 'messageEmpty', id: 1 }],
  });
  await assert.rejects(pages(connector, req), /unavailable messages/);
  await api.destroy();
});
