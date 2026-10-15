import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { BaseTelegramClient, IntermediatePacketCodec, MtTimeoutError, TelegramClient, tl } from '@mtcute/node';
import { AppError, TgFloodWait } from '../../contracts/index.ts';
import { createTelegramFactory } from './connector.ts';
import { MtcuteApi } from './mtcute-api.ts';
import { createMtcuteClient } from './mtcute-client.ts';
import { offlineContext } from './mtcute-test-support.ts';

const marker = 'PRIVATE_SYNTHETIC_MARKER';
const phone = '+10000000000';
const hash = 'private-code-hash';
const diagnostic = (reason: string, rpcStatus?: number) => ({
  level: 'warn',
  event: 'connector.telegram_login_failed',
  fields: { operation: 'send_code', accountId: 1, reason, ...(rpcStatus === undefined ? {} : { rpcStatus }) },
});

function rpc(text: string, status: unknown = 400) {
  const error = new tl.RpcError(400, text);
  Object.defineProperty(error, 'code', { value: status, configurable: true });
  return error;
}
function hostile<T extends Error>(error: T): T {
  error.message = marker;
  error.name = marker;
  error.stack = marker;
  error.cause = { message: marker, cause: { phone, password: marker, session: marker } };
  Object.assign(error, { request: { phone, hash, code: marker }, context: marker });
  return error;
}

async function setup(t: TestContext, mode: 'custom' | 'tdl', reject?: unknown) {
  const state = offlineContext();
  if (mode === 'tdl') state.ctx.config = { APPLICATION_PROFILE: 'tdl' };
  let connects = 0;
  const client = createMtcuteClient(state.ctx, {
    packetCodec: () => new IntermediatePacketCodec(),
    async connect() {
      connects++;
      throw new Error('Offline transport must never connect');
    },
  });
  assert.ok(client.sdk instanceof TelegramClient);
  const base = client.sdk._client;
  assert.ok(base instanceof BaseTelegramClient);
  t.after(async () => {
    await client.sdk.stopUpdatesLoop();
    await client.sdk.destroy();
    assert.equal(connects, 0);
  });
  await client.sdk.importSession({ authKey: new Uint8Array(256).fill(7) });
  t.mock.method(base.mt.network, 'getPrimaryDcId', () => 2);
  const calls: string[] = [];
  t.mock.method(base, 'call', async (request: tl.RpcMethod) => {
    calls.push(request._);
    assert.equal(request._, 'auth.sendCode');
    if (request._ !== 'auth.sendCode') assert.fail('Unexpected RPC');
    assert.equal(request.phoneNumber, '10000000000');
    if (mode === 'custom')
      assert.deepEqual({ apiId: request.apiId, apiHash: request.apiHash }, { apiId: 123, apiHash: 'synthetic' });
    else
      assert.equal(
        createHash('sha256')
          .update(JSON.stringify({ apiId: request.apiId, apiHash: request.apiHash }))
          .digest('hex'),
        'ef28f502a3e800814ad32a2261904cbe6257081baf1173d092b0f1d3b3ca2978',
      );
    if (reject !== undefined) throw reject;
    return { _: 'auth.sentCode', type: { _: 'auth.sentCodeTypeApp', length: 5 }, phoneCodeHash: hash };
  });
  let constructed = 0;
  const api = new MtcuteApi(state.ctx, () => {
    constructed++;
    assert.equal(constructed, 1); // no replacement identity or hidden fallback
    return client;
  });
  return { ...state, api, calls, constructed: () => constructed, connects: () => connects };
}

const reasons = [
  'PHONE_NUMBER_INVALID',
  'API_ID_INVALID',
  'API_ID_PUBLISHED_FLOOD',
  'PHONE_NUMBER_FLOOD',
  'PHONE_NUMBER_BANNED',
  'UPDATE_APP_TO_LOGIN',
  'AUTH_RESTART',
];
for (const mode of ['custom', 'tdl'] as const) {
  for (const reason of reasons) {
    test(`${mode}: actual SDK sendCode logs ${reason} before generic RPC translation without private fields`, async (t) => {
      const state = await setup(t, mode, hostile(rpc(reason)));
      await assert.rejects(state.api.sendCode(phone), (error: unknown) => {
        assert.deepEqual(state.logs, [diagnostic(reason, 400)]); // already present at the public rejection boundary
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'invalid');
        assert.equal(error.message, 'Telegram request failed');
        return true;
      });
      assert.deepEqual(state.calls, ['auth.sendCode']);
      assert.equal(state.constructed(), 1);
      assert.equal(state.connects(), 0);
      assert.deepEqual(state.saved, []);
      const output = JSON.stringify(state.logs);
      for (const secret of [marker, phone, '10000000000', hash]) assert.ok(!output.includes(secret));
    });
  }
}

for (const [text, reason] of [
  ['FLOOD_WAIT_37', 'FLOOD_WAIT'],
  ['SLOWMODE_WAIT_38', 'FLOOD_WAIT'],
  ['FLOOD_TEST_PHONE_WAIT_39', 'FLOOD_WAIT'],
  ['FLOOD_PREMIUM_WAIT_40', 'FLOOD_WAIT'],
  ['AUTH_RESTART_12', 'AUTH_RESTART'],
]) {
  test(`actual SDK normalized ${text} produces only fixed ${reason}, public error unchanged`, async (t) => {
    const error = hostile(tl.RpcError.fromTl({ _: 'rpc_error', errorCode: 420, errorMessage: text }));
    const state = await setup(t, 'tdl', error);
    await assert.rejects(state.api.sendCode(phone), (error: unknown) => {
      assert.deepEqual(state.logs, [diagnostic(reason as string, 420)]);
      assert.ok(error instanceof AppError);
      assert.equal(error.message, 'Telegram request failed'); // existing translation of normalized %d errors
      return true;
    });
    assert.deepEqual(state.calls, ['auth.sendCode']);
  });
}

test('direct numeric flood RpcError keeps existing TgFloodWait without a retry or dynamic diagnostic', async (t) => {
  const state = await setup(t, 'custom', hostile(rpc('FLOOD_WAIT_37', 420)));
  await assert.rejects(state.api.sendCode(phone), (error: unknown) => {
    assert.deepEqual(state.logs, [diagnostic('FLOOD_WAIT', 420)]);
    assert.ok(error instanceof TgFloodWait);
    assert.equal(error.seconds, 37);
    return true;
  });
  assert.deepEqual(state.calls, ['auth.sendCode']);
});

for (const text of [
  marker,
  'API_ID_INVALID_PRIVATE_SYNTHETIC',
  'CUSTOM_REASON_12345',
  'PHONE_NUMBER_INVALID\nPRIVATE',
  'FLOOD_WAIT_PRIVATE',
  'FLOOD_WAIT_37_PRIVATE',
]) {
  test(`unknown raw reason ${text.replaceAll('\n', ' ')} collapses to one unknown and Host-facing flow stays generic`, async (t) => {
    const state = await setup(t, 'tdl', hostile(rpc(text)));
    const connector = createTelegramFactory(() => state.api).create(state.ctx);
    assert.equal((await connector.login(null)).kind, 'need_input');
    const result = await connector.login({ phone });
    assert.deepEqual(result, { kind: 'failed', message: 'Login failed; retry the requested field', retryable: true });
    assert.deepEqual(state.logs, [
      diagnostic('unknown', 400),
      { level: 'warn', event: 'connector.login_failed', fields: { accountId: 1 } },
    ]);
    assert.deepEqual(state.calls, ['auth.sendCode']);
    assert.deepEqual(state.saved, []);
    assert.ok(!JSON.stringify({ logs: state.logs, result }).includes(text));
    assert.ok(!JSON.stringify(state.logs).includes(marker));
  });
}

for (const status of [NaN, Infinity, 400.5, -1, 99, 600, '401', marker]) {
  test(`invalid RPC status ${status} is omitted at actual helper failure`, async (t) => {
    const state = await setup(t, 'custom', hostile(rpc(marker, status)));
    await assert.rejects(state.api.sendCode(phone), { message: 'Telegram request failed' });
    assert.deepEqual(state.logs, [diagnostic('unknown')]);
    assert.deepEqual(state.calls, ['auth.sendCode']);
  });
}

test('401 classification preserves existing unauthenticated AppError', async (t) => {
  const state = await setup(t, 'custom', hostile(rpc('CUSTOM_REASON_12345', 401)));
  await assert.rejects(state.api.sendCode(phone), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'unauthenticated');
    assert.equal(error.message, 'Telegram request failed');
    return true;
  });
  assert.deepEqual(state.logs, [diagnostic('unknown', 401)]);
  assert.deepEqual(state.calls, ['auth.sendCode']);
});

for (const [error, reason] of [
  [hostile(new MtTimeoutError(123)), 'local_transport_timeout'],
  [hostile(new TypeError(marker)), 'local_runtime'],
  [hostile(new RangeError(marker)), 'local_runtime'],
  [hostile(Object.assign(new Error(marker), { code: 'ECONNRESET', text: 'API_ID_INVALID' })), 'unknown'],
  [hostile(Object.assign(new Error(marker), { name: 'MtArgumentError', text: 'PHONE_NUMBER_INVALID' })), 'unknown'],
] as const) {
  test(`actual helper lower local failure ${reason} retains original public exception without raw logging`, async (t) => {
    const state = await setup(t, 'custom', error);
    await assert.rejects(state.api.sendCode(phone), (actual: unknown) => {
      assert.equal(actual, error);
      assert.deepEqual(state.logs, [diagnostic(reason)]);
      return true;
    });
    assert.deepEqual(state.calls, ['auth.sendCode']);
  });
}

test('real SDK phone validation fails before auth RPC and logs a fixed local validation label', async (t) => {
  const state = await setup(t, 'custom');
  await assert.rejects(state.api.sendCode(marker), { message: 'Invalid phone number' });
  assert.deepEqual(state.logs, [diagnostic('local_validation')]);
  assert.deepEqual(state.calls, []);
});

test('successful actual SDK sendCode emits no failure diagnostic or extra RPC', async (t) => {
  const state = await setup(t, 'tdl');
  assert.deepEqual(await state.api.sendCode(phone), { phoneCodeHash: hash });
  assert.deepEqual(state.calls, ['auth.sendCode']);
  assert.deepEqual(state.logs, []);
  assert.deepEqual(state.saved, []);
});

test('a throwing diagnostic sink cannot replace the actual lower error or change its generic translation', async (t) => {
  const state = await setup(t, 'custom', hostile(rpc('API_ID_INVALID')));
  let observed = 0;
  state.ctx.log = () => {
    observed++;
    throw new Error(marker);
  };
  await assert.rejects(state.api.sendCode(phone), { message: 'Telegram request failed' });
  assert.equal(observed, 1);
  assert.deepEqual(state.calls, ['auth.sendCode']);
});
