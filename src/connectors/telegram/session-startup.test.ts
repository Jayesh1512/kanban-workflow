import assert from 'node:assert/strict';
import test from 'node:test';
import { type tl, User } from '@mtcute/node';
import type { TelegramApi } from '../../contracts/index.ts';
import { AppError } from '../../contracts/index.ts';
import { createTelegramFactory } from './connector.ts';
import { MtcuteApi } from './mtcute-api.ts';
import { createMtcuteClient } from './mtcute-client.ts';
import { sdkData } from './mtcute-test-data.ts';
import { blockedTransport, offlineContext } from './mtcute-test-support.ts';
import { deferred, sessionHarness } from './session-test-support.ts';
import { login } from './test-session.ts';

const safeFailure = (e: unknown) =>
  e instanceof AppError && e.code === 'invalid' && e.message === 'Connector session persistence failed';

test('C1-F6 neutral pending startup rejects latched first-message save failure on both SDK exits', async () => {
  for (const rejects of [false, true]) {
    const h = sessionHarness(1);
    await login(h.connector);
    const entered = deferred();
    const release = deferred();
    let handlers: Parameters<TelegramApi['startUpdates']>[0] | undefined;
    h.api.startUpdates = async (next) => {
      handlers = next;
      entered.resolve();
      await release.promise;
      if (rejects) throw new Error('synthetic canceled startup');
    };
    const starting = h.connector.start(h.sink);
    const outcome = starting.then(
      () => null,
      (e: unknown) => e,
    );
    await entered.promise;
    assert.ok(handlers);
    const first = h.source.messages[0];
    assert.ok(first);
    const authoritative = h.saved.at(-1);
    let saves = 0;
    h.ctx.saveSession = () => {
      saves++;
      throw new Error('synthetic private callback detail');
    };
    await assert.rejects(handlers.onNew(first), safeFailure);
    assert.equal(saves, 1);
    assert.equal(h.saved.at(-1), authoritative);
    assert.equal(h.api.calls.filter((c) => c.op === 'destroy').length, 1);
    release.resolve();
    assert.ok(safeFailure(await outcome), 'start must reject the same fixed persistence failure');
    const count = h.events.length;
    await handlers.onNew(first);
    await handlers.onEdit(first);
    await handlers.onDelete({ ids: [first.id], channelId: null });
    handlers.onState('connected');
    await Promise.resolve();
    assert.equal(h.events.length, count);
    assert.ok(h.events.every((e) => e.type === 'status' && e.state === 'disconnected'));
    await assert.rejects(h.connector.listChats(), safeFailure);
    assert.equal(h.api.calls.filter((c) => c.op === 'destroy').length, 1);
    assert.ok(!JSON.stringify(h.logs).includes('synthetic private callback detail'));
  }
});

test('C1-F6 production MtcuteApi actual SDK listener pending loop-start save failure rejects start without transport or revival', async (t) => {
  const state = offlineContext();
  const data = sdkData(1);
  let connects = 0;
  const client = createMtcuteClient(state.ctx, {
    ...blockedTransport,
    async connect() {
      connects++;
      throw new Error('offline');
    },
  });
  const entered = deferred();
  const release = deferred();
  t.mock.method(client.sdk, 'importSession', async () => {});
  t.mock.method(client.sdk, 'getMe', async () => new User(data.users[0] as tl.RawUser));
  t.mock.method(client.sdk, 'exportSession', async () => 'synthetic-opaque');
  t.mock.method(client.sdk, 'connect', async () => {});
  t.mock.method(client.sdk, 'startUpdatesLoop', async () => {
    entered.resolve();
    await release.promise;
  });
  const destroy = t.mock.method(client.sdk, 'destroy', client.sdk.destroy.bind(client.sdk));
  const close = t.mock.method(client, 'closeNow', client.closeNow.bind(client));
  const api = new MtcuteApi(state.ctx, () => client);
  state.ctx.session = 'synthetic-opaque';
  const connector = createTelegramFactory(() => api).create(state.ctx);
  const starting = connector.start(state.sink);
  const outcome = starting.then(
    () => null,
    (e: unknown) => e,
  );
  await entered.promise;
  const onNew = client.sdk.onNewMessage.listeners()[0];
  const onState = client.sdk.onConnectionState.listeners()[0];
  const message = data.parsed[0];
  assert.ok(onNew && onState && message);
  let saves = 0;
  state.ctx.saveSession = () => {
    saves++;
    throw new Error('synthetic private save detail');
  };
  await assert.rejects(onNew(message), safeFailure);
  assert.equal(saves, 1);
  assert.equal(destroy.mock.callCount(), 1);
  assert.equal(close.mock.callCount(), 1);
  assert.equal(client.sdk.onNewMessage.length, 0);
  assert.equal(client.sdk.onConnectionState.length, 0);
  release.resolve();
  assert.ok(safeFailure(await outcome), 'production start must reject latched persistence failure');
  const count = state.events.length;
  await onNew(message);
  onState('connected');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(state.events.length, count);
  assert.ok(state.events.every((e) => e.type === 'status' && e.state === 'disconnected'));
  assert.equal(connects, 0);
  assert.equal(destroy.mock.callCount(), 1);
  assert.equal(close.mock.callCount(), 1);
  assert.ok(state.waits.every((w) => w.ms === 5000));
  await assert.rejects(connector.listChats(), safeFailure);
  assert.ok(!JSON.stringify(state.logs).includes('synthetic private save detail'));
});

test('C1-F6 startup restoration and reimport exits preserve concurrent latched lifecycle failure', async () => {
  for (const boundary of ['restoreImport', 'getMe', 'reimport'] as const) {
    for (const rejects of [false, true]) {
      const h = sessionHarness(1, JSON.stringify({ v: 1, selfId: 10 }));
      if (boundary === 'reimport') await h.connector.listChats();
      const entered = deferred();
      const release = deferred();
      const importing = h.api.importSession.bind(h.api);
      const getMe = h.api.getMe.bind(h.api);
      let calls = 0;
      if (boundary === 'getMe')
        h.api.getMe = async () => {
          if (++calls !== 1) return getMe();
          const user = await getMe();
          entered.resolve();
          await release.promise;
          if (rejects) throw new Error('synthetic late ready error');
          return user;
        };
      else
        h.api.importSession = async (value) => {
          if (++calls !== 1) return importing(value);
          entered.resolve();
          await release.promise;
          if (rejects) throw new Error('synthetic late import error');
          await importing(value);
        };
      const starting = h.connector.start(h.sink);
      const outcome = starting.then(
        () => null,
        (e: unknown) => e,
      );
      await entered.promise;
      h.ctx.saveSession = () => {
        throw new Error('synthetic concurrent login save failure');
      };
      await assert.rejects(h.connector.login(null), safeFailure);
      release.resolve();
      assert.ok(safeFailure(await outcome));
      assert.equal(h.api.calls.filter((c) => c.op === 'destroy').length, 1);
      assert.equal(h.api.calls.filter((c) => c.op === 'startUpdates').length, 0);
      assert.deepEqual(h.saved, []);
      assert.deepEqual(h.events, []);
    }
  }
});

test('C1-F6 explicit stop/logout still cancel pending startup without false persistence fault or late callbacks', async () => {
  for (const cancellation of ['stop', 'logout'] as const) {
    for (const rejects of [false, true]) {
      const h = sessionHarness(1);
      await login(h.connector);
      const entered = deferred();
      const release = deferred();
      let handlers: Parameters<TelegramApi['startUpdates']>[0] | undefined;
      h.api.startUpdates = async (next) => {
        handlers = next;
        entered.resolve();
        await release.promise;
        if (rejects) throw new AppError('invalid', 'Connector stopped');
      };
      const starting = h.connector.start(h.sink);
      await entered.promise;
      await h.connector[cancellation]();
      const saves = h.saved.length;
      release.resolve();
      await starting;
      assert.ok(handlers);
      const first = h.source.messages[0];
      assert.ok(first);
      await handlers.onNew(first);
      handlers.onState('connected');
      await Promise.resolve();
      assert.deepEqual(h.events, []);
      assert.equal(h.saved.length, saves);
      if (cancellation === 'logout') {
        assert.equal(h.saved.at(-1), null);
        assert.equal((await h.connector.login(null)).kind, 'need_input');
      } else {
        assert.equal((await h.connector.login(null)).kind, 'done');
      }
    }
  }
});
