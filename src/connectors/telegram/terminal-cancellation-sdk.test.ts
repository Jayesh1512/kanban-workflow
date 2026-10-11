import assert from 'node:assert/strict';
import test from 'node:test';
import { BaseTelegramClient, IntermediatePacketCodec, TelegramClient, type tl } from '@mtcute/node';
import { createTelegramFactory } from './connector.ts';
import { MtcuteApi } from './mtcute-api.ts';
import { createMtcuteClient } from './mtcute-client.ts';
import { offlineContext } from './mtcute-test-support.ts';
import { sessionPrefix } from './session-state.ts';
import { flush, gate } from './terminal-test-support.ts';

for (const rejects of [false, true]) {
  test(`Actual captured SDK final cancellation aborts once; old destruction ${rejects ? 'reject' : 'resolve'} stays detached`, async (t) => {
    const state = offlineContext();
    let connects = 0;
    const transport = {
      packetCodec: () => new IntermediatePacketCodec(),
      async connect() {
        connects++;
        throw new Error('No transport permitted');
      },
    };
    const old = createMtcuteClient(state.ctx, transport);
    const fresh = createMtcuteClient(state.ctx, transport);
    assert.ok(old.sdk instanceof TelegramClient);
    await old.sdk.importSession({ authKey: new Uint8Array(256).fill(7) });
    await fresh.sdk.importSession({ authKey: new Uint8Array(256).fill(8) });
    const opaque = await old.sdk.exportSession();
    const freshOpaque = await fresh.sdk.exportSession();
    const held = gate();
    const destroy = old.sdk.destroy.bind(old.sdk);
    const destroying = t.mock.method(old.sdk, 'destroy', async () => {
      try {
        await held.promise;
      } finally {
        await destroy();
      }
    });
    const close = old.closeNow.bind(old);
    const closing = t.mock.method(old, 'closeNow', () => close());
    const base = old.sdk._client;
    assert.ok(base instanceof BaseTelegramClient);
    t.mock.method(base.mt.network, 'getPrimaryDcId', () => 2);
    let rpcs = 0;
    t.mock.method(base, 'call', async (request: tl.RpcMethod) => {
      assert.equal(request._, 'auth.logOut');
      assert.ok(await old.storage.authKeys.get(2));
      rpcs++;
      return { _: 'auth.loggedOut' };
    });
    const ctx = { ...state.ctx, session: sessionPrefix + JSON.stringify({ v: 1, sdkSession: opaque, keys: [] }) };
    let index = 0;
    const api = new MtcuteApi(ctx, () => (index++ === 0 ? old : fresh));
    const connector = createTelegramFactory(() => api).create(ctx);
    const outcome = (work: Promise<void>) =>
      work.then(
        () => null,
        (error: Error) => error,
      );
    const logout = outcome(connector.logout());
    await flush();
    assert.deepEqual(state.saved, [null]);
    const stop = outcome(connector.stop());
    await flush();
    assert.equal(closing.mock.callCount(), 1);
    assert.equal(destroying.mock.callCount(), 1);
    // Release for both BEFORE and AFTER; all old rejection paths are observed.
    if (rejects) held.reject(new Error('private old SDK destruction'));
    else held.resolve();
    const [result, stopped] = await Promise.all([logout, stop]);
    await api.importSession(freshOpaque);
    const saved = await api.exportSession();
    await flush();
    assert.equal(await api.exportSession(), saved);
    assert.equal(saved, freshOpaque);
    assert.equal(connects, 0);
    assert.equal(rpcs, 1);
    assert.equal(closing.mock.callCount(), 1);
    assert.equal(destroying.mock.callCount(), 1);
    assert.deepEqual(state.saved, [null]);
    await api.destroy();
    assert.equal(result?.message, 'Connector logout timed out/cancelled');
    assert.equal(stopped, result);
  });
}
