import assert from 'node:assert/strict';
import test from 'node:test';
import { BaseTelegramClient, DeleteMessageUpdate, TelegramClient, tl } from '@mtcute/node';
import { AppError } from '../../contracts/index.ts';
import { MtcuteApi } from './mtcute-api.ts';
import { createMtcuteClient } from './mtcute-client.ts';
import { blockedTransport, offlineContext } from './mtcute-test-support.ts';

test('C1-F2 actual SDK swallowed AUTH_KEY_UNREGISTERED startup cannot succeed or revive through late callbacks', async (t) => {
  const state = offlineContext();
  let connects = 0;
  const client = createMtcuteClient(state.ctx, {
    ...blockedTransport,
    async connect() {
      connects++;
      throw new Error('offline');
    },
  });
  assert.ok(client.sdk instanceof TelegramClient);
  const sdk = client.sdk;
  const base = Reflect.get(sdk, '_client');
  assert.ok(base instanceof BaseTelegramClient);
  const middleware = base.params.network?.middlewares?.[0];
  assert.ok(middleware);
  t.mock.method(sdk, 'connect', async () => {});
  t.mock.method(sdk, 'exportSession', async () => 'synthetic-opaque');
  let rpcCount = 0;
  let lateState: ((s: 'connected') => void) | undefined;
  let lateDelete: ReturnType<typeof sdk.onDeleteMessage.listeners>[number] | undefined;
  const states: string[] = [];
  const api = new MtcuteApi(state.ctx, () => client);
  t.mock.method(base, 'call', async (request: tl.RpcMethod) => {
    assert.equal(request._, 'updates.getState');
    lateState ??= sdk.onConnectionState.listeners()[0];
    lateDelete ??= sdk.onDeleteMessage.listeners()[0];
    const raw = { _: 'mt_rpc_error' as const, errorCode: 401, errorMessage: 'AUTH_KEY_UNREGISTERED' };
    const result = await middleware({ request, manager: base.mt.network }, async () => {
      rpcCount++;
      return raw;
    });
    assert.equal(result, raw);
    throw tl.RpcError.fromTl(raw);
  });
  const handlers = {
    async onNew() {
      assert.fail('delivery after auth loss');
    },
    async onEdit() {
      assert.fail('edit after auth loss');
    },
    async onDelete() {
      assert.fail('delete after auth loss');
    },
    onState(s: 'connected' | 'disconnected' | 'auth_lost') {
      states.push(s);
    },
  };
  try {
    await assert.rejects(
      api.startUpdates(handlers),
      (e) => e instanceof AppError && e.code === 'unauthenticated' && e.message === 'Telegram authorization lost',
    );
    assert.ok(lateState);
    lateState('connected');
    assert.ok(lateDelete);
    await lateDelete(new DeleteMessageUpdate({ _: 'updateDeleteMessages', messages: [1], pts: 1, ptsCount: 0 }));
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(states.includes('auth_lost'));
    assert.ok(!states.includes('connected'));
    assert.ok(base.updates);
    assert.equal(base.updates.updatesLoopActive, false);
    assert.ok(rpcCount >= 1 && rpcCount <= 2);
    assert.equal(connects, 0);
    assert.equal(sdk.onNewMessage.length, 0);
    assert.ok(lateDelete); // retain callback evidence even after listener detachment
  } finally {
    await api.destroy();
  }
});
