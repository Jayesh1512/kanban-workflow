import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TelegramApi, TgDialog, TgMessage, TgPeer } from '../../contracts/index.ts';
import { testContext } from '../test-support.ts';
import { createTelegramFactory, telegramLoginNotice } from './connector.ts';
import { RecordedApi } from './recorded-api.ts';
import { readSession } from './session-state.ts';
import { expected, login, pages, recording } from './test-session.ts';

test('R4.1 boundary [F]: 1600 typed synthetic messages (200 per kind/direction) preserve all fields live and history, both directions and chat boxes', async () => {
  const source = recording(1600);
  const state = testContext();
  const api = new RecordedApi({ session: source }, state.ctx.now);
  const connector = createTelegramFactory(() => api).create(state.ctx);
  await login(connector);
  const listing = await connector.listChats();
  assert.deepEqual(
    listing.map((l) => [l.chat.key, l.chat.kind]),
    [
      ['u:10:20', 'direct'],
      ['g:30', 'group'],
      ['c:40', 'group'],
      ['c:50', 'broadcast'],
    ],
  );
  assert.ok(listing.every((l) => Object.keys(l).join() === 'chat,latestAt,latestCursor'));
  await connector.start(state.sink);
  await api.advanceTo('end');
  const delivered = state.events.filter((event) => event.type === 'message');
  assert.equal(delivered.length, 1600);
  assert.deepEqual(
    delivered.map((e) => e.message),
    source.messages.map(expected),
  );
  for (const entry of listing) {
    const live = delivered.filter((e) => e.chat.key === entry.chat.key);
    for (const sender of ['10', '20']) {
      assert.equal(
        source.messages.filter(
          (m) => `${m.peer.type}:${m.peer.id}` === entry.chat.nativeId && String(m.sender.id) === sender,
        ).length,
        200,
      );
      assert.equal(live.filter((e) => e.message.sender.userKey === sender).length, 200);
    }
    const result = await pages(connector, { chat: entry.chat, after: null, since: null, limit: null, resume: null });
    const wanted = source.messages
      .filter((m) => `${m.peer.type}:${m.peer.id}` === entry.chat.nativeId)
      .sort((a, b) => b.id - a.id)
      .map(expected);
    assert.deepEqual(
      result.flatMap((p) => p.messages),
      wanted,
    );
    assert.equal(result.at(-1)?.resume, null);
  }
  await connector.stop();
  assert.ok(state.saved.length >= 2);
  assert.ok(
    api.calls.every((c) =>
      [
        'sendCode',
        'signIn',
        'exportSession',
        'importSession',
        'getMe',
        'dialogs',
        'history',
        'startUpdates',
        'destroy',
      ].includes(c.op),
    ),
  );
  // Host inclusion/storage is separately required at H1; this is actual connector-boundary evidence only.
});

test('R4.2 login/password, opaque import/export and null logout; every API call logged without credentials', async () => {
  const source = { ...recording(1), passwordNeeded: true };
  const state = testContext();
  const api = new RecordedApi({ session: source }, state.ctx.now);
  const connector = createTelegramFactory(() => api).create(state.ctx);
  await login(connector, true);
  assert.equal((await connector.login({ password: 'bad' })).kind, 'failed');
  const session = state.saved[0];
  assert.equal(typeof session, 'string');
  const restored = testContext(session as string);
  const otherApi = new RecordedApi({ session: source }, restored.ctx.now);
  const other = createTelegramFactory(() => otherApi).create(restored.ctx);
  await other.start(restored.sink);
  await other.logout();
  assert.equal(restored.saved.at(-1), null);
  await assert.rejects(other.listChats(), /Login required/);
  await otherApi.advanceTo('end');
  assert.equal(restored.events.filter((e) => e.type === 'message').length, 0);
  assert.deepEqual(
    otherApi.calls.map((c) => c.op),
    ['importSession', 'getMe', 'importSession', 'startUpdates', 'logOut', 'destroy'],
  );
  assert.ok(!JSON.stringify(api.calls).includes('synthetic-password'));
  assert.ok(!JSON.stringify(api.calls).includes('+10000000000'));
});

test('R6.6 [F] 300 dialogs/50 one-page missed chats cost 53 paced requests; none missed costs list only', async () => {
  const source = recording(0);
  source.dialogs = Array.from(
    { length: 300 },
    (_, n): TgDialog => ({
      peer: { type: 'supergroup', id: n + 1 },
      title: `Synthetic group ${n}`,
      lastMessageId: 2,
      lastMessageDate: 1800000000,
    }),
  );
  source.messages = source.dialogs.slice(0, 50).map((d, n) => ({
    id: 2,
    peer: d.peer,
    sender: source.self,
    date: 1800000000 + n,
    text: 'Synthetic missed',
    media: null,
    mediaUniqueId: null,
    replyToId: null,
    editDate: null,
    isService: false,
  }));
  const state = testContext();
  const api = new RecordedApi({ session: source }, state.ctx.now);
  const connector = createTelegramFactory(() => api).create(state.ctx);
  await login(connector);
  const listing = await connector.listChats();
  for (const entry of listing.slice(0, 50))
    await pages(connector, { chat: entry.chat, after: '1', since: null, limit: null, resume: null });
  const calls = api.calls.filter((c) => c.op === 'dialogs' || c.op === 'history');
  assert.equal(calls.length, 53);
  assert.ok(calls.every((c) => (c.limit ?? 0) <= 100));
  for (let n = 1; n < calls.length; n++) assert.ok((calls[n]?.atMs ?? 0) - (calls[n - 1]?.atMs ?? 0) >= 3000);
  assert.equal(calls.at(-1)?.atMs, 156000);
  const previous = api.calls.length;
  await connector.listChats(); // Equality of stored/latest cursor means host requests no history.
  assert.equal(api.calls.slice(previous).filter((c) => c.op === 'dialogs' || c.op === 'history').length, 3);
});

test('R6.6 flood wait is obeyed then interval doubles for call; >600s throws a host-visible gap cause', async () => {
  const source = recording(0);
  source.dialogs = Array.from({ length: 201 }, (_, n) => ({
    peer: { type: 'group' as const, id: n + 1 },
    title: '',
    lastMessageId: null,
    lastMessageDate: null,
  }));
  source.failures = [{ op: 'dialogs', seconds: 10 }];
  const state = testContext();
  const api = new RecordedApi({ session: source }, state.ctx.now);
  const connector = createTelegramFactory(() => api).create(state.ctx);
  await login(connector);
  await connector.listChats();
  assert.deepEqual(
    api.calls.filter((c) => c.op === 'dialogs').map((c) => c.atMs),
    [0, 10000, 16000, 22000],
  );
  const bad = new RecordedApi({ session: { ...source, failures: [{ op: 'dialogs', seconds: 601 }] } }, state.ctx.now);
  const failed = createTelegramFactory(() => bad).create(state.ctx);
  await login(failed);
  await assert.rejects(failed.listChats(), /retry boundary/);
  assert.equal(bad.calls.filter((c) => c.op === 'dialogs').length, 1);
});

test('R10 decode: edits retain initial key, deletes distinguish common/channel boxes; service cursor survives empty catchup', async () => {
  const source = recording(1);
  const initial = source.messages[0] as TgMessage;
  const service = { ...initial, id: 9, isService: true };
  source.dialogs = [{ peer: initial.peer, title: 'Synthetic', lastMessageId: 9, lastMessageDate: service.date }];
  source.messages.push(service);
  source.updates.push(
    { type: 'edit', message: { ...initial, text: 'Synthetic changed', editDate: initial.date + 2 } },
    { type: 'delete', ids: [1], channelId: null },
    { type: 'delete', ids: [1], channelId: 99 },
    { type: 'new', message: service },
  );
  const state = testContext();
  const api = new RecordedApi({ session: source }, state.ctx.now);
  const connector = createTelegramFactory(() => api).create(state.ctx);
  await login(connector);
  await connector.start(state.sink);
  await api.advanceTo('end');
  const original = state.events.find((e) => e.type === 'message');
  const edit = state.events.find((e) => e.type === 'edit');
  assert.ok(original?.type === 'message' && edit?.type === 'edit');
  assert.equal(edit.message.key, original.message.key);
  assert.equal(edit.message.text, 'Synthetic changed');
  assert.equal(edit.message.editedAt, new Date((initial.date + 2) * 1000).toISOString());
  assert.deepEqual(
    state.events.filter((e) => e.type === 'delete').map((e) => e.nativeIds),
    [['u:1'], ['c99:1']],
  );
  const listing = await connector.listChats();
  assert.equal(listing[0]?.latestCursor, '9');
  const entry = listing[0];
  assert.ok(entry);
  const result = await pages(connector, { chat: entry.chat, after: '1', since: null, limit: null, resume: null });
  assert.deepEqual(result, [{ messages: [], resume: null }]);
  assert.equal(state.events.filter((e) => e.type === 'message').length, 1);
});

test('History bounds and query-bound resume continue below yielded page without repeated messages', async () => {
  const source = recording(0);
  const peer: TgPeer = { type: 'supergroup', id: 1 };
  source.dialogs = [{ peer, title: '', lastMessageId: 220, lastMessageDate: 1800000220 }];
  source.messages = Array.from({ length: 220 }, (_, n) => ({
    id: n + 1,
    peer,
    sender: source.self,
    date: 1800000000 + n,
    text: '',
    media: null,
    mediaUniqueId: null,
    replyToId: null,
    editDate: null,
    isService: false,
  }));
  const state = testContext();
  const api = new RecordedApi({ session: source }, state.ctx.now);
  const connector = createTelegramFactory(() => api).create(state.ctx);
  await login(connector);
  const entry = (await connector.listChats())[0];
  assert.ok(entry);
  const chat = entry.chat;
  const req = { chat, after: '10', since: new Date(1800000150 * 1000).toISOString(), limit: 50, resume: null };
  assert.equal((await pages(connector, req)).flatMap((p) => p.messages).length, 50);
  const full = { chat, after: '10', since: null, limit: 150, resume: null };
  const iterator = connector.fetchHistory(full)[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value.messages.length, 100);
  await iterator.return?.();
  const rest = await pages(connector, { ...full, resume: first.value.resume });
  assert.equal(rest.flatMap((p) => p.messages).length, 50);
  assert.equal(rest[0]?.messages[0]?.cursor, '120');
  await assert.rejects(pages(connector, { ...full, limit: 151, resume: first.value.resume }), /resume token/);
});

test('R7 instance isolation, callback backpressure, sink failure disconnect, and no calls after stop', async () => {
  const source = recording(3);
  source.updates.splice(1, 0, { type: 'mark', name: 'first' });
  const state = testContext();
  const api = new RecordedApi({ session: source }, state.ctx.now);
  const connector = createTelegramFactory(() => api).create(state.ctx);
  await login(connector);
  let release: () => void = () => {};
  let enter: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  await connector.start({
    async emit(event) {
      state.events.push(event);
      if (event.type === 'message') {
        enter();
        await blocked;
      }
    },
  });
  const replay = api.advanceTo('end');
  await entered;
  assert.equal(state.events.filter((e) => e.type === 'message').length, 1);
  await connector.stop();
  const count = state.events.length;
  release();
  await replay;
  assert.equal(state.events.length, count);
  const secondState = testContext();
  const secondApi = new RecordedApi({ session: recording(3) }, secondState.ctx.now);
  const second = createTelegramFactory(() => secondApi).create(secondState.ctx);
  await login(second);
  const received: string[] = [];
  await second.start({
    async emit(event) {
      received.push(event.type === 'status' ? event.state : event.type);
      if (event.type === 'message') throw new Error('Synthetic sink rejection');
    },
  });
  await assert.rejects(secondApi.advanceTo('end'), /Synthetic sink rejection/);
  await secondApi.advanceTo('end');
  assert.deepEqual(received, ['connected', 'message', 'disconnected']);
  assert.equal(secondState.saved.length, 2); // login and first saved key, before rejecting delivery
  assert.equal(state.saved.length, 3); // login, first saved key, stop
  assert.equal(readSession(secondState.saved.at(-1) as string).keys.size, 1);
});

test('RecordedApi path loading and registration-owner three-risk notice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'connector-recorded-'));
  try {
    const path = join(dir, 'session.json');
    writeFileSync(path, JSON.stringify(recording(0)));
    const api = new RecordedApi({ path }, () => new Date(0));
    const port: TelegramApi = api;
    assert.equal(typeof port.history, 'function');
    assert.deepEqual(api.calls, []);
    const notice = telegramLoginNotice({ APP_OWNER: 'Named owner' });
    assert.equal(notice.version, 1);
    for (const phrase of ['full control', 'under observation', 'Named owner', 'every teammate'])
      assert.ok(notice.text.includes(phrase));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('Stop invalidates a still-pending restored start before any sink call', async () => {
  const source = recording(1);
  const state = testContext(JSON.stringify({ v: 1, selfId: 10 }));
  let release: () => void = () => {};
  let enter: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  class DelayedImport extends RecordedApi {
    override async importSession(session: string) {
      enter();
      await pending;
      await super.importSession(session);
    }
  }
  const api = new DelayedImport({ session: source }, state.ctx.now);
  const connector = createTelegramFactory(() => api).create(state.ctx);
  const starting = connector.start(state.sink);
  await entered;
  await connector.stop();
  release();
  await starting;
  await api.advanceTo('end');
  assert.deepEqual(state.events, []);
  assert.ok(!api.calls.some((c) => c.op === 'startUpdates'));
  assert.ok(!api.calls.some((c) => c.op === 'getMe')); // A stopped restoration cannot initiate a new read/connection.
});

test('Two accounts agree on direct/basic-group keys despite different common message box native IDs', async () => {
  const source = recording(4);
  const otherSource = structuredClone(source);
  otherSource.self = { id: 20, displayName: 'Outside', username: null };
  otherSource.dialogs = otherSource.dialogs.map((dialog) =>
    dialog.peer.type === 'user' ? { ...dialog, peer: { type: 'user', id: 10 } } : dialog,
  );
  otherSource.messages = otherSource.messages.map((m) => ({
    ...m,
    id: m.peer.type === 'user' || m.peer.type === 'group' ? m.id + 100 : m.id,
    peer: m.peer.type === 'user' ? { type: 'user', id: 10 } : m.peer,
  }));
  otherSource.updates = otherSource.messages.map((message) => ({ type: 'new', message }));
  const a = testContext();
  const b = testContext(null, 2);
  const apiA = new RecordedApi({ session: source }, a.ctx.now);
  const apiB = new RecordedApi({ session: otherSource }, b.ctx.now);
  const first = createTelegramFactory(() => apiA).create(a.ctx);
  const second = createTelegramFactory(() => apiB).create(b.ctx);
  await login(first);
  await login(second);
  await first.start(a.sink);
  await second.start(b.sink);
  await apiA.advanceTo('end');
  await apiB.advanceTo('end');
  const recordsA = a.events.filter((e) => e.type === 'message');
  const recordsB = b.events.filter((e) => e.type === 'message');
  assert.deepEqual(
    recordsA.map((e) => [e.chat.key, e.message.key]),
    recordsB.map((e) => [e.chat.key, e.message.key]),
  );
  assert.notEqual(recordsA[0]?.message.nativeId, recordsB[0]?.message.nativeId);
});
