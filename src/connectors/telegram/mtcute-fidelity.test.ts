import assert from 'node:assert/strict';
import test from 'node:test';
import { DeleteMessageUpdate, Long, Message, type tl, User } from '@mtcute/node';
import type { TgMessage } from '../../contracts/index.ts';
import { testContext } from '../test-support.ts';
import { createTelegramFactory } from './connector.ts';
import { MtcuteApi } from './mtcute-api.ts';
import { createMtcuteClient } from './mtcute-client.ts';
import { mtMessage } from './mtcute-decode.ts';
import { sdkData, sdkMedia } from './mtcute-test-data.ts';
import { blockedTransport, offlineContext } from './mtcute-test-support.ts';
import { expected, pages } from './test-session.ts';

test('R4.1/R4.2 actual MtcuteApi synthetic seam: 1600 SDK messages (200 per kind/direction), listings, paged history and exact read call inventory', async (t) => {
  const data = sdkData(1600, true);
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
  assert.equal(delivered.length, 1600);
  for (const peer of data.peers) {
    for (const out of [false, true]) {
      assert.equal(
        data.messages.filter((m) => JSON.stringify(m.peerId) === JSON.stringify(peer) && m.out === out).length,
        200,
      );
    }
  }
  assert.ok(data.messages.every((m) => m.out === (m.fromId?._ === 'peerUser' && m.fromId.userId === 10)));
  const samples = sdkMedia();
  const wanted: TgMessage[] = data.messages.map((raw, n) => ({
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
    media: (samples[n % 13]?.kind ?? null) as TgMessage['media'],
    mediaUniqueId: (() => {
      const media = data.parsed[n]?.media;
      return media && 'uniqueFileId' in media ? media.uniqueFileId : null;
    })(),
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
    for (const sender of ['10', '20']) {
      assert.equal(
        wanted.filter((m) => `${m.peer.type}:${m.peer.id}` === entry.chat.nativeId && String(m.sender.id) === sender)
          .length,
        200,
      );
      assert.equal(byChat.filter((e) => e.message.sender.userKey === sender).length, 200);
    }
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
