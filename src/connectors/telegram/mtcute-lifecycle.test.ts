import assert from 'node:assert/strict';
import test from 'node:test';
import { BaseTelegramClient, DeleteMessageUpdate, TelegramClient } from '@mtcute/node';
import { MtcuteApi } from './mtcute-api.ts';
import { createMtcuteClient } from './mtcute-client.ts';
import { sdkData } from './mtcute-test-data.ts';
import { blockedTransport, offlineContext } from './mtcute-test-support.ts';

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
