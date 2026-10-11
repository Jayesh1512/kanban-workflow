import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { BaseTelegramClient, IntermediatePacketCodec, TelegramClient, type tl } from '@mtcute/node';
import { apiControl } from './api-lifecycle.ts';
import { createTelegramFactory } from './connector.ts';
import { MtcuteApi } from './mtcute-api.ts';
import { createMtcuteClient } from './mtcute-client.ts';
import { offlineContext } from './mtcute-test-support.ts';
import { flush, gate } from './terminal-test-support.ts';

async function actualAuthClient(t: TestContext, state: ReturnType<typeof offlineContext>, held = gate()) {
  let connects = 0;
  const client = createMtcuteClient(state.ctx, {
    packetCodec: () => new IntermediatePacketCodec(),
    async connect() {
      connects++;
      throw new Error('No transport allowed');
    },
  });
  assert.ok(client.sdk instanceof TelegramClient);
  const base = client.sdk._client;
  assert.ok(base instanceof BaseTelegramClient);
  t.after(async () => {
    await client.sdk.stopUpdatesLoop();
    await client.sdk.destroy();
  });
  // Synthetic primary key models the transport-created key. Import has NO self; actual fetch is initially null.
  await client.sdk.importSession({ authKey: new Uint8Array(256).fill(7) });
  assert.equal(await base.storage.self.fetch(), null);
  t.mock.method(base.mt.network, 'getPrimaryDcId', () => 2);
  const calls: string[] = [];
  t.mock.method(base, 'call', async (request: tl.RpcMethod) => {
    calls.push(request._);
    switch (request._) {
      case 'auth.sendCode':
        await held.promise;
        return {
          _: 'auth.sentCodeSuccess',
          authorization: {
            _: 'auth.authorization',
            user: { _: 'user', id: 10, self: true, firstName: 'Synthetic owner' },
          },
        };
      case 'updates.getState':
        return { _: 'updates.state', pts: 1, qts: 0, date: 1800000000, seq: 1, unreadCount: 0 };
      case 'updates.getDifference':
        return { _: 'updates.differenceEmpty', date: 1800000000, seq: 1 };
      case 'auth.logOut': {
        const dcs = await base.mt.storage.dcs.fetch();
        assert.ok(dcs);
        assert.deepEqual(Buffer.from((await client.storage.authKeys.get(dcs.main.id)) ?? []), Buffer.alloc(256, 7));
        return { _: 'auth.loggedOut' };
      }
      default:
        throw new Error(`Unexpected lower RPC ${request._}`);
    }
  });
  return { client, base, calls, held, connects: () => connects };
}

test('F8 ACTUAL sentCodeSuccess helper authorizes current client; neutral failure still logs out once', async (t) => {
  const state = offlineContext();
  const h = await actualAuthClient(t, state);
  const api = new MtcuteApi(state.ctx, () => h.client);
  const connector = createTelegramFactory(() => api).create(state.ctx);
  assert.equal((await connector.login(null)).kind, 'need_input');
  h.held.resolve();
  assert.equal((await connector.login({ phone: '+10000000000' })).kind, 'failed');
  await flush();
  assert.equal((await h.base.storage.self.fetch())?.userId, 10);
  assert.ok(h.calls.includes('updates.getState') && h.calls.includes('updates.getDifference'));
  const tracked = apiControl(api)?.authenticated();
  // Always destroy through the public terminal method before the assertion, even on the old defect.
  await connector.logout();
  assert.equal(tracked, true);
  assert.equal(h.calls.filter((op) => op === 'auth.logOut').length, 1);
  assert.equal(h.connects(), 0);
  assert.deepEqual(state.saved, [null]);
});

for (const rejects of [false, true]) {
  test(`F8 ACTUAL cancelled sendCode late ${rejects ? 'reject' : 'authorization'} cannot authenticate fresh client`, async (t) => {
    const state = offlineContext();
    const old = await actualAuthClient(t, state);
    const fresh = await actualAuthClient(t, state);
    let index = 0;
    const api = new MtcuteApi(state.ctx, () => (index++ === 0 ? old.client : fresh.client));
    const connector = createTelegramFactory(() => api).create(state.ctx);
    await connector.login(null);
    const login = connector.login({ phone: '+10000000000' });
    await flush();
    assert.deepEqual(old.calls, ['auth.sendCode']);
    await connector.logout();
    const newer = api.sendCode('+10000000000');
    const newerResult = assert.rejects(newer, /Account already authorized; restart login/);
    await flush();
    assert.equal(apiControl(api)?.authenticated(), false);
    if (rejects) old.held.reject(new Error('PRIVATE cancelled auth response'));
    else old.held.resolve();
    assert.equal((await login).kind, 'failed');
    await old.client.sdk.stopUpdatesLoop();
    await flush();
    assert.equal(apiControl(api)?.authenticated(), false);
    assert.equal(await fresh.base.storage.self.fetch(), null);
    assert.equal(old.calls.filter((op) => op === 'auth.logOut').length, 0);
    assert.deepEqual(state.saved, [null]);
    // A CURRENT successful helper result must install auth independently of the old completion.
    fresh.held.resolve();
    await newerResult;
    const currentAuth = apiControl(api)?.authenticated();
    await connector.logout();
    assert.equal(currentAuth, true);
    assert.equal(fresh.calls.filter((op) => op === 'auth.logOut').length, 1);
    assert.equal(old.connects() + fresh.connects(), 0);
    assert.deepEqual(state.saved, [null, null]);
  });
}
