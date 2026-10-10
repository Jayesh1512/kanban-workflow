import assert from 'node:assert/strict';
import test from 'node:test';
import type { TelegramTransport } from '@mtcute/node';
import {
  BaseTelegramClient,
  DeleteMessageUpdate,
  IntermediatePacketCodec,
  Long,
  MemoryStorageDriver,
  Message,
  TelegramClient,
  tl,
  User,
} from '@mtcute/node';
import type { TgMessage } from '../../contracts/index.ts';
import { TgFloodWait } from '../../contracts/index.ts';
import { testContext } from '../test-support.ts';
import { createTelegramFactory } from './connector.ts';
import { MtcuteApi } from './mtcute-api.ts';
import { createMtcuteClient } from './mtcute-client.ts';
import { mtMessage } from './mtcute-decode.ts';
import { sdkData, sdkMedia } from './mtcute-test-data.ts';
import { expected, pages } from './test-session.ts';

function offlineContext() {
  const state = testContext();
  state.ctx.config = { API_ID: '123', API_HASH: 'synthetic', APP_OWNER: 'Owner' };
  const waits: { ms: number; resolve(): void }[] = [];
  state.ctx.sleep = (ms) =>
    new Promise<void>((resolve) => {
      waits.push({ ms, resolve });
    });
  return { ...state, waits };
}
const blockedTransport: TelegramTransport = {
  packetCodec: () => new IntermediatePacketCodec(),
  async connect() {
    throw new Error('Offline transport must never connect');
  },
};

test('R4.6 source-informed offline SDK construction: real MemoryStorage export/import and no socket or native SQLite', async () => {
  const state = offlineContext();
  const first = createMtcuteClient(state.ctx, blockedTransport);
  const second = createMtcuteClient(state.ctx, blockedTransport);
  assert.ok(first.sdk instanceof TelegramClient && second.sdk instanceof TelegramClient);
  assert.ok(first.storage.driver instanceof MemoryStorageDriver);
  await first.sdk.importSession({
    authKey: new Uint8Array(256).fill(7),
    self: { userId: 10, isBot: false, isPremium: false, usernames: [] },
  });
  const session = await first.sdk.exportSession();
  assert.equal(typeof session, 'string');
  await second.sdk.importSession(session);
  assert.equal(await second.sdk.exportSession(), session);
  assert.equal(first.sdk.onNewMessage.length, 0);
  assert.deepEqual(state.events, []);
  await first.sdk.destroy();
  await second.sdk.destroy();
});

test('R4.1/R4.2 actual MtcuteApi synthetic seam: 220 SDK messages, listings, paged history and exact read call inventory', async (t) => {
  const data = sdkData();
  const state = offlineContext();
  // Pacing uses a controlled clock. Cleanup deadline remains pending until explicitly advanced.
  const pace = testContext();
  state.ctx.now = pace.ctx.now;
  state.ctx.sleep = async (ms) => {
    if (ms === 5000) await new Promise<void>(() => {});
    else await pace.ctx.sleep(ms);
  };
  const client = createMtcuteClient(state.ctx, blockedTransport);
  const calls: string[] = [];
  t.mock.method(client.sdk, 'getMe', async () => {
    calls.push('getMe');
    return new User(data.users[0] as tl.RawUser);
  });
  t.mock.method(client.sdk, 'importSession', async () => {
    calls.push('importSession');
  });
  t.mock.method(client.sdk, 'exportSession', async () => {
    calls.push('exportSession');
    return 'synthetic-opaque';
  });
  t.mock.method(client.sdk, 'connect', async () => {
    calls.push('connect');
  });
  t.mock.method(client.sdk, 'startUpdatesLoop', async () => {
    calls.push('startUpdatesLoop');
  });
  client.dialogs = async (request) => {
    calls.push(request._);
    assert.equal(request.limit, 100);
    assert.equal(request.folderId, undefined);
    return {
      _: 'messages.dialogs',
      dialogs: data.dialogs,
      messages: data.messages.slice(-4),
      users: data.users,
      chats: data.chats,
    };
  };
  client.history = async (request) => {
    calls.push(request._);
    assert.ok(request.limit <= 100);
    const peer = request.peer;
    const rawPeer =
      peer._ === 'inputPeerUser'
        ? { _: 'peerUser', userId: peer.userId }
        : peer._ === 'inputPeerChat'
          ? { _: 'peerChat', chatId: peer.chatId }
          : peer._ === 'inputPeerChannel'
            ? { _: 'peerChannel', channelId: peer.channelId }
            : null;
    assert.ok(rawPeer);
    return {
      _: 'messages.messages',
      topics: [],
      users: data.users,
      chats: data.chats,
      messages: data.messages
        .filter(
          (m) =>
            JSON.stringify(m.peerId) === JSON.stringify(rawPeer) &&
            m.id > request.minId &&
            (!request.maxId || m.id < request.maxId),
        )
        .toReversed()
        .slice(0, request.limit),
    };
  };
  const api = new MtcuteApi(state.ctx, () => client);
  const connector = createTelegramFactory(() => api).create({ ...state.ctx, session: 'synthetic-opaque' });
  const listing = await connector.listChats();
  assert.deepEqual(
    listing.map((e) => e.chat.key),
    ['u:10:20', 'g:30', 'c:40', 'c:50'],
  );
  assert.ok(listing.every((e) => Object.keys(e).join() === 'chat,latestAt,latestCursor'));
  await connector.start(state.sink);
  for (const message of data.parsed) client.sdk.onNewMessage.emit(message);
  // A sentinel delete awaits the same adapter queue, proving all previous deliveries completed.
  const end = client.sdk.onDeleteMessage.listeners()[0];
  assert.ok(end);
  await end(new DeleteMessageUpdate({ _: 'updateDeleteMessages', messages: [], pts: 1, ptsCount: 0 }));
  const delivered = state.events.filter((e) => e.type === 'message');
  assert.equal(delivered.length, 220);
  const wanted: TgMessage[] = data.messages.map((raw) => ({
    id: raw.id,
    peer:
      raw.peerId._ === 'peerUser'
        ? { type: 'user', id: 20 }
        : raw.peerId._ === 'peerChat'
          ? { type: 'group', id: 30 }
          : { type: raw.peerId.channelId === 40 ? 'supergroup' : 'channel', id: raw.peerId.channelId },
    sender:
      raw.fromId?._ === 'peerUser' && raw.fromId.userId === 10
        ? { id: 10, displayName: 'Owner', username: 'owner' }
        : { id: 20, displayName: 'Outside', username: null },
    date: raw.date,
    text: raw.message,
    media: raw.media ? 'contact' : null,
    mediaUniqueId: null,
    replyToId: raw.replyTo?._ === 'messageReplyHeader' ? (raw.replyTo.replyToMsgId ?? null) : null,
    editDate: null,
    isService: false,
  }));
  assert.deepEqual(
    delivered.map((e) => e.message),
    wanted.map(expected),
  );
  for (const entry of listing) {
    const result = await pages(connector, { chat: entry.chat, after: null, since: null, limit: null, resume: null });
    assert.deepEqual(
      result.flatMap((p) => p.messages),
      wanted
        .filter((m) => `${m.peer.type}:${m.peer.id}` === entry.chat.nativeId)
        .toReversed()
        .map(expected),
    );
    const byChat = delivered.filter((e) => e.chat.key === entry.chat.key);
    assert.ok(byChat.some((e) => e.message.sender.userKey === '10'));
    assert.ok(byChat.some((e) => e.message.sender.userKey === '20'));
  }
  const first = data.parsed[0];
  assert.ok(first);
  const edited = new Message(
    { ...first.raw, _: 'message', message: 'Synthetic edited', editDate: first.raw.date + 1 },
    data.index,
  );
  const edit = client.sdk.onEditMessage.listeners()[0];
  assert.ok(edit);
  await edit(edited);
  const initial = delivered[0];
  const change = state.events.find((e) => e.type === 'edit');
  assert.ok(initial && change?.type === 'edit');
  assert.equal(change.message.key, initial.message.key);
  await end(
    new DeleteMessageUpdate({ _: 'updateDeleteChannelMessages', messages: [1], channelId: 40, pts: 1, ptsCount: 0 }),
  );
  assert.deepEqual(state.events.at(-1), {
    type: 'delete',
    nativeIds: ['c40:1'],
    deletedAt: state.ctx.now().toISOString(),
  });
  await connector.stop();
  const count = state.events.length;
  client.sdk.onNewMessage.emit(first);
  assert.equal(state.events.length, count);
  assert.ok(
    calls.every((op) =>
      [
        'getMe',
        'importSession',
        'exportSession',
        'connect',
        'startUpdatesLoop',
        'messages.getDialogs',
        'messages.getHistory',
      ].includes(op),
    ),
  );
});

test('Actual MtcuteApi login phone/code/password, flood translation and null logout through neutral connector', async (t) => {
  const state = offlineContext();
  const data = sdkData();
  const client = createMtcuteClient(state.ctx, blockedTransport);
  const user = new User(data.users[0] as tl.RawUser);
  const calls: string[] = [];
  t.mock.method(client.sdk, 'sendCode', async () => {
    calls.push('auth.sendCode');
    return { phoneCodeHash: 'synthetic-hash' };
  });
  t.mock.method(client.sdk, 'signIn', async () => {
    calls.push('auth.signIn');
    throw new tl.RpcError(401, 'SESSION_PASSWORD_NEEDED');
  });
  t.mock.method(client.sdk, 'checkPassword', async () => {
    calls.push('auth.checkPassword');
    return user;
  });
  t.mock.method(client.sdk, 'exportSession', async () => 'synthetic-opaque');
  t.mock.method(client.sdk, 'logOut', async () => {
    calls.push('auth.logOut');
  });
  const api = new MtcuteApi(state.ctx, () => client);
  const connector = createTelegramFactory(() => api).create(state.ctx);
  assert.equal((await connector.login(null)).kind, 'need_input');
  assert.equal((await connector.login({ phone: '+10000000000' })).kind, 'need_input');
  const step = await connector.login({ code: 'synthetic' });
  assert.ok(step.kind === 'need_input');
  assert.equal(step.fields[0]?.name, 'password');
  assert.equal((await connector.login({ password: 'synthetic' })).kind, 'done');
  assert.equal(state.saved.at(-1), 'synthetic-opaque');
  client.dialogs = async () => {
    throw new tl.RpcError(420, 'FLOOD_WAIT_601');
  };
  await assert.rejects(api.dialogs({ offset: null, limit: 100 }), (e) => e instanceof TgFloodWait && e.seconds === 601);
  await connector.logout();
  assert.equal(state.saved.at(-1), null);
  assert.deepEqual(calls, ['auth.sendCode', 'auth.signIn', 'auth.checkPassword', 'auth.logOut']);
});

test('Actual adapter sink backpressure, rejection disconnect, queued generation invalidation and five-second cleanup bound', async (t) => {
  const state = offlineContext();
  const client = createMtcuteClient(state.ctx, blockedTransport);
  const data = sdkData();
  t.mock.method(client.sdk, 'connect', async () => {});
  t.mock.method(client.sdk, 'startUpdatesLoop', async () => {});
  t.mock.method(client.sdk, 'exportSession', async () => 'synthetic-opaque');
  let closeCount = 0;
  client.closeNow = () => {
    closeCount++;
  };
  const api = new MtcuteApi(state.ctx, () => client);
  let release: () => void = () => {};
  let enter: () => void = () => {};
  const entered = new Promise<void>((r) => {
    enter = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const seen: string[] = [];
  await api.startUpdates({
    async onNew() {
      seen.push('new');
      enter();
      await gate;
    },
    async onEdit() {
      seen.push('edit');
    },
    async onDelete() {
      seen.push('delete');
    },
    onState(s) {
      seen.push(s);
    },
  });
  const onNew = client.sdk.onNewMessage.listeners()[0];
  const onEdit = client.sdk.onEditMessage.listeners()[0];
  assert.ok(onNew && onEdit);
  const first = data.parsed[0];
  assert.ok(first);
  const pending = onNew(first);
  const queued = onEdit(first);
  await entered;
  assert.ok(!seen.includes('edit'));
  await api.destroy();
  release();
  await pending;
  await queued;
  assert.ok(!seen.includes('edit'));
  assert.equal(client.sdk.onNewMessage.length, 0);
  assert.equal(closeCount, 1);

  const next = createMtcuteClient(state.ctx, blockedTransport);
  t.mock.method(next.sdk, 'connect', async () => {});
  t.mock.method(next.sdk, 'startUpdatesLoop', async () => {});
  t.mock.method(next.sdk, 'exportSession', async () => 'synthetic-opaque');
  const failure = new MtcuteApi(state.ctx, () => next);
  await failure.startUpdates({
    async onNew() {
      throw new Error('Synthetic sink failure');
    },
    async onEdit() {
      assert.fail('delivery after failure');
    },
    async onDelete() {},
    onState(s) {
      seen.push(s);
    },
  });
  const fail = next.sdk.onNewMessage.listeners()[0];
  assert.ok(fail);
  await assert.rejects(async () => {
    await fail(first);
  }, /Synthetic sink failure/);
  await Promise.resolve();
  assert.equal(next.sdk.onNewMessage.length, 0);
  assert.equal(seen.at(-1), 'disconnected');
  await failure.destroy();

  const stuck = createMtcuteClient(state.ctx, blockedTransport);
  t.mock.method(stuck.sdk, 'importSession', async () => {});
  t.mock.method(stuck.sdk, 'exportSession', async () => 'synthetic-opaque');
  t.mock.method(stuck.sdk, 'destroy', () => new Promise<void>(() => {}));
  const bounded = new MtcuteApi(state.ctx, () => stuck);
  await bounded.importSession('synthetic-opaque');
  const stopping = bounded.destroy();
  const rejection = assert.rejects(stopping, /five seconds/);
  state.waits.at(-1)?.resolve();
  await rejection;
  // Restore the real offline SDK destroy so the test leaves no SDK resources.
  t.mock.restoreAll();
  await stuck.sdk.destroy();
});

test('SDK media decode retains caption, service metadata, reply IDs and unknown media placeholder', () => {
  const data = sdkData();
  const raw = data.messages[0];
  assert.ok(raw);
  const unknown = mtMessage(
    new Message({ ...raw, media: { _: 'messageMediaDice', value: 1, emoticon: '🎲' } }, data.index),
  );
  assert.equal(unknown.media, 'other');
  assert.equal(unknown.text, raw.message);
  const service = mtMessage(
    new Message(
      {
        _: 'messageService',
        id: 999,
        peerId: raw.peerId,
        fromId: raw.fromId,
        date: raw.date,
        action: { _: 'messageActionPinMessage' },
      },
      data.index,
    ),
  );
  assert.equal(service.isService, true);
  assert.equal(service.date, raw.date);
  assert.equal(service.id, 999);
  for (const sample of sdkMedia()) {
    const parsed = new Message({ ...raw, media: sample.media }, data.index);
    const decoded = mtMessage(parsed);
    assert.equal(decoded.media, sample.kind);
    assert.equal(decoded.text, raw.message);
    assert.equal(
      decoded.replyToId,
      raw.replyTo?._ === 'messageReplyHeader' ? (raw.replyTo.replyToMsgId ?? null) : null,
    );
    if (sample.file) {
      assert.equal(typeof decoded.mediaUniqueId, 'string');
      assert.ok(decoded.mediaUniqueId);
      // Credentials/file references can vary between accounts; the unique file ID must remain unchanged.
      const variant = { ...sample.media };
      if (variant._ === 'messageMediaPhoto' && variant.photo?._ === 'photo') {
        variant.photo = { ...variant.photo, accessHash: Long.ZERO, fileReference: new Uint8Array([1]) };
      }
      if (variant._ === 'messageMediaDocument' && variant.document?._ === 'document') {
        variant.document = { ...variant.document, accessHash: Long.ZERO, fileReference: new Uint8Array([1]) };
      }
      assert.equal(mtMessage(new Message({ ...raw, media: variant }, data.index)).mediaUniqueId, decoded.mediaUniqueId);
    } else assert.equal(decoded.mediaUniqueId, null);
  }
});

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

test('Actual adapter cancels late update-loop start and protects cleanup from throwing void state observer', async (t) => {
  const state = offlineContext();
  const client = createMtcuteClient(state.ctx, blockedTransport);
  t.mock.method(client.sdk, 'connect', async () => {});
  t.mock.method(client.sdk, 'exportSession', async () => 'synthetic-opaque');
  let enter: () => void = () => {};
  let release: () => void = () => {};
  const entered = new Promise<void>((r) => {
    enter = r;
  });
  const waiting = new Promise<void>((r) => {
    release = r;
  });
  t.mock.method(client.sdk, 'startUpdatesLoop', async () => {
    enter();
    await waiting;
  });
  let stopped = 0;
  t.mock.method(client.sdk, 'stopUpdatesLoop', async () => {
    stopped++;
  });
  const api = new MtcuteApi(state.ctx, () => client);
  const start = api.startUpdates({
    async onNew() {
      assert.fail('late delivery');
    },
    async onEdit() {},
    async onDelete() {},
    onState() {
      assert.fail('late state');
    },
  });
  const rejected = assert.rejects(start, /Connector stopped/);
  await entered;
  await api.destroy();
  release();
  await rejected;
  assert.ok(stopped >= 1);
  assert.equal(client.sdk.onNewMessage.length, 0);

  const next = createMtcuteClient(state.ctx, blockedTransport);
  t.mock.method(next.sdk, 'connect', async () => {});
  t.mock.method(next.sdk, 'startUpdatesLoop', async () => {});
  let closes = 0;
  const close = next.closeNow;
  next.closeNow = () => {
    closes++;
    close();
  };
  const failure = new MtcuteApi(state.ctx, () => next);
  await failure.startUpdates({
    async onNew() {},
    async onEdit() {},
    async onDelete() {},
    onState() {
      throw new Error('Synthetic state observer failure');
    },
  });
  // Await queued state and rejection cleanup without a wall-clock wait.
  const listener = next.sdk.onDeleteMessage.listeners()[0];
  if (listener)
    await listener(new DeleteMessageUpdate({ _: 'updateDeleteMessages', messages: [], pts: 1, ptsCount: 0 }));
  assert.equal(next.sdk.onNewMessage.length, 0);
  assert.ok(closes >= 1);
  await failure.destroy();
});

test('Installed non-retrying middleware preserves flood/password errors and surfaces swallowed authorization loss', async (t) => {
  const state = offlineContext();
  const client = createMtcuteClient(state.ctx, blockedTransport);
  assert.ok(client.sdk instanceof TelegramClient);
  const sdk = client.sdk;
  // The pinned Node wrapper holds its real base client here; inspect only, never connect it.
  const base = Reflect.get(sdk, '_client');
  assert.ok(base instanceof BaseTelegramClient);
  const middleware = base.params.network?.middlewares?.[0];
  assert.ok(middleware);
  assert.equal(base.params.network?.middlewares?.length, 1);
  t.mock.method(sdk, 'connect', async () => {});
  t.mock.method(sdk, 'startUpdatesLoop', async () => {});
  const states: string[] = [];
  const api = new MtcuteApi(state.ctx, () => client);
  await api.startUpdates({
    async onNew() {},
    async onEdit() {},
    async onDelete() {},
    onState(s) {
      states.push(s);
    },
  });
  const flush = sdk.onDeleteMessage.listeners()[0];
  assert.ok(flush);
  const empty = new DeleteMessageUpdate({ _: 'updateDeleteMessages', messages: [], pts: 1, ptsCount: 0 });
  await flush(empty);
  let calls = 0;
  for (const [errorCode, errorMessage] of [
    [420, 'FLOOD_WAIT_601'],
    [401, 'SESSION_PASSWORD_NEEDED'],
    [401, 'AUTH_KEY_UNREGISTERED'],
  ] as const) {
    const error = { _: 'mt_rpc_error' as const, errorCode, errorMessage };
    const result = await middleware({ request: { _: 'updates.getState' }, manager: base.mt.network }, async () => {
      calls++;
      return error;
    });
    assert.equal(result, error);
    await flush(empty);
    assert.equal(states.at(-1), errorMessage === 'AUTH_KEY_UNREGISTERED' ? 'auth_lost' : 'connected');
  }
  assert.equal(calls, 3);
  assert.deepEqual(state.waits, []);
  await api.destroy();
});
