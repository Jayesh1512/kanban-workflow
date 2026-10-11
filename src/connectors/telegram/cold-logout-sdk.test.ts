import assert from 'node:assert/strict';
import test from 'node:test';
import { BaseTelegramClient, IntermediatePacketCodec, TelegramClient, type tl } from '@mtcute/node';
import { createTelegramFactory } from './connector.ts';
import { MtcuteApi } from './mtcute-api.ts';
import { createMtcuteClient } from './mtcute-client.ts';
import { offlineContext } from './mtcute-test-support.ts';
import { sessionPrefix } from './session-state.ts';

test('Cold logout actual pinned SDK restores synthetic auth key before lower auth.logOut, zero transport', async (t) => {
  const state = offlineContext();
  let connects = 0;
  const transport = {
    packetCodec: () => new IntermediatePacketCodec(),
    async connect() {
      connects++;
      throw new Error('No Telegram transport permitted');
    },
  };
  const seed = createMtcuteClient(state.ctx, transport);
  await seed.sdk.importSession({
    authKey: new Uint8Array(256).fill(9),
    self: { userId: 10, isBot: false, isPremium: false, usernames: [] },
  });
  const saved = await seed.sdk.exportSession();
  await seed.sdk.destroy();
  const client = createMtcuteClient(state.ctx, transport);
  assert.ok(client.sdk instanceof TelegramClient);
  const base = client.sdk._client;
  assert.ok(base instanceof BaseTelegramClient);
  // Local notification needs a primary-DC selector normally installed by connection.
  t.mock.method(base.mt.network, 'getPrimaryDcId', () => 2);
  let calls = 0;
  t.mock.method(base, 'call', async (request: tl.RpcMethod) => {
    assert.equal(request._, 'auth.logOut');
    const dcs = await base.mt.storage.dcs.fetch();
    assert.ok(dcs);
    assert.deepEqual(
      Buffer.from((await base.mt.storage.provider.authKeys.get(dcs.main.id)) ?? []),
      Buffer.alloc(256, 9),
    );
    calls++;
    return { _: 'auth.loggedOut' };
  });
  const ctx = { ...state.ctx, session: sessionPrefix + JSON.stringify({ v: 1, sdkSession: saved, keys: [] }) };
  const exporting = t.mock.method(client.sdk, 'exportSession', async () => {
    throw new Error('Teardown must not export');
  });
  const reading = t.mock.method(client.sdk, 'getMe', async () => {
    throw new Error('Teardown must not getMe');
  });
  const api = new MtcuteApi(ctx, () => client);
  try {
    await createTelegramFactory(() => api)
      .create(ctx)
      .logout();
    assert.equal(calls, 1);
    assert.equal(connects, 0);
    assert.equal(exporting.mock.callCount(), 0);
    assert.equal(reading.mock.callCount(), 0);
    assert.deepEqual(state.saved, [null]);
  } finally {
    await api.destroy();
  }
});
