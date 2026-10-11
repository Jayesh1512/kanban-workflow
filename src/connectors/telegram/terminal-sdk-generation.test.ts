import assert from 'node:assert/strict';
import test from 'node:test';
import { BaseTelegramClient, Message, PeersIndex, TelegramClient, type tl, User } from '@mtcute/node';
import { createTelegramFactory } from './connector.ts';
import { MtcuteApi } from './mtcute-api.ts';
import { createMtcuteClient } from './mtcute-client.ts';
import { sdkData } from './mtcute-test-data.ts';
import { blockedTransport, offlineContext } from './mtcute-test-support.ts';
import { sessionPrefix } from './session-state.ts';
import { flush, gate, safePersistence } from './terminal-test-support.ts';

for (const rejects of [false, true]) {
  test(`Captured SDK old destructor late ${rejects ? 'reject' : 'resolve'} cannot touch imported or fresh client`, async (t) => {
    const state = offlineContext();
    const data = sdkData();
    const old = createMtcuteClient(state.ctx, blockedTransport);
    const restored = createMtcuteClient(state.ctx, blockedTransport);
    const fresh = createMtcuteClient(state.ctx, blockedTransport);
    const clients = [old, restored, fresh];
    const seed = createMtcuteClient(state.ctx, blockedTransport);
    await seed.sdk.importSession({
      authKey: new Uint8Array(256).fill(4),
      self: { userId: 10, isBot: false, isPremium: false, usernames: [] },
    });
    const opaque = await seed.sdk.exportSession();
    await seed.sdk.destroy();
    const ctx = { ...state.ctx, session: sessionPrefix + JSON.stringify({ v: 1, sdkSession: opaque, keys: [] }) };
    const held = gate();
    const closes = [0, 0, 0];
    const destroys = [0, 0, 0];
    const rpcs = [0, 0, 0];
    for (const [i, client] of clients.entries()) {
      assert.ok(client.sdk instanceof TelegramClient);
      const base = client.sdk._client;
      assert.ok(base instanceof BaseTelegramClient);
      t.mock.method(client, 'closeNow', () => {
        closes[i] = (closes[i] ?? 0) + 1;
      });
      const destroy = client.sdk.destroy.bind(client.sdk);
      t.mock.method(client.sdk, 'destroy', async () => {
        destroys[i] = (destroys[i] ?? 0) + 1;
        try {
          if (i === 0) await held.promise;
        } finally {
          await destroy();
        }
      });
      t.mock.method(client.sdk, 'getMe', async () => new User(data.users[0] as tl.RawUser));
      t.mock.method(client.sdk, 'connect', async () => {});
      t.mock.method(client.sdk, 'startUpdatesLoop', async () => {});
      t.mock.method(base.mt.network, 'getPrimaryDcId', () => 2);
      t.mock.method(base, 'call', async (request: tl.RpcMethod) => {
        assert.equal(request._, 'auth.logOut');
        assert.ok(await client.storage.authKeys.get(2));
        rpcs[i] = (rpcs[i] ?? 0) + 1;
        return { _: 'auth.loggedOut' };
      });
    }
    let index = 0;
    const api = new MtcuteApi(ctx, () => {
      const client = clients[index++];
      assert.ok(client);
      return client;
    });
    const connector = createTelegramFactory(() => api).create(ctx);
    await connector.start(state.sink);
    let nulls = 0;
    ctx.saveSession = (value) => {
      if (value !== null) throw new Error('private prospective save failure');
      nulls++;
      state.saved.push(value);
    };
    const listener = old.sdk.onNewMessage.listeners()[0];
    // SDK emitters expose captured listeners through the real callback seam in adjacent tests.
    assert.ok(listener);
    const raw = data.messages[0];
    assert.ok(raw);
    const message = new Message(raw, PeersIndex.from(data));
    await assert.rejects(async () => {
      await listener(message);
    }, safePersistence);
    await flush();
    assert.equal(closes[0], 1);
    assert.equal(destroys[0], 1);
    await assert.rejects(connector.logout(), safePersistence);
    assert.deepEqual(rpcs, [0, 1, 0]);
    assert.deepEqual(closes, [1, 1, 0]);
    assert.deepEqual(destroys, [1, 1, 0]);
    assert.equal(nulls, 1);
    ctx.saveSession = (value) => state.saved.push(value);
    await api.importSession(opaque);
    const current = await api.exportSession();
    if (rejects) held.reject(new Error('private old destroy'));
    else held.resolve();
    await flush();
    assert.equal(await api.exportSession(), current);
    assert.equal(nulls, 1);
    assert.deepEqual(destroys, [1, 1, 0]);
    await api.destroy();
    assert.deepEqual(destroys, [1, 1, 1]);
  });
}

for (const rejects of [false, true]) {
  test(`Old cleanup export late ${rejects ? 'failure' : 'value'} cannot replace new SDK session or fault its export`, async (t) => {
    const state = offlineContext();
    const old = createMtcuteClient(state.ctx, blockedTransport);
    const fresh = createMtcuteClient(state.ctx, blockedTransport);
    await old.sdk.importSession({ authKey: new Uint8Array(256).fill(3) });
    await fresh.sdk.importSession({ authKey: new Uint8Array(256).fill(5) });
    const oldValue = await old.sdk.exportSession();
    const freshValue = await fresh.sdk.exportSession();
    assert.notEqual(oldValue, freshValue);
    const held = gate<string>();
    t.mock.method(old.sdk, 'exportSession', async () => held.promise);
    let count = 0;
    const api = new MtcuteApi(state.ctx, () => (count++ === 0 ? old : fresh));
    await api.importSession(oldValue);
    const destruction = api.destroy();
    const observed = destruction.catch(() => {});
    await api.importSession(freshValue);
    assert.equal(await api.exportSession(), freshValue);
    if (rejects) held.reject(new Error('private old export'));
    else held.resolve(oldValue);
    await observed;
    assert.equal(await api.exportSession(), freshValue);
    await api.destroy();
  });
}
