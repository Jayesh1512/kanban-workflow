import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { BaseTelegramClient, IntermediatePacketCodec, Long, TelegramClient, tl } from '@mtcute/node';
import { telegramApplication } from './application-profile.ts';
import { createTelegramFactory, telegramLoginNotice } from './connector.ts';
import { MtcuteApi } from './mtcute-api.ts';
import { createMtcuteClient } from './mtcute-client.ts';
import { blockedTransport, offlineContext } from './mtcute-test-support.ts';
import { readSession } from './session-state.ts';

const custom = { API_ID: '123', API_HASH: 'synthetic-private-hash', APP_OWNER: 'Named owner' };
const preset = { APPLICATION_PROFILE: 'tdl' };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('custom selection and version1 notice remain exactly unchanged, including the missing-owner notice', () => {
  for (const config of [{}, custom, { ...custom, APPLICATION_PROFILE: 'custom' }]) {
    assert.deepEqual(telegramLoginNotice(config), {
      version: 1,
      text: `The stored session gives full control of your account; Telegram offers no read-only credential. Telegram puts unofficial-client accounts under observation and may restrict them; the rate for read-only use is unknown. The application is registered under ${config.APP_OWNER ?? '(registration owner not configured)'}'s phone number; Telegram notifies that account and its remedy ends access for every teammate.`,
    });
  }
  assert.deepEqual(telegramApplication(custom), { apiId: 123, apiHash: 'synthetic-private-hash' });
  assert.deepEqual(telegramApplication({ ...custom, APPLICATION_PROFILE: 'custom' }), telegramApplication(custom));
  for (const config of [{}, { ...custom, API_ID: '0' }, { ...custom, API_HASH: '' }, { API_ID: '123' }])
    assert.throws(() => telegramApplication(config), /Telegram API_ID, API_HASH and APP_OWNER are required/);
});

test('tdl notice2 separates source attribution from unverified registrant and shared availability', () => {
  const notice = telegramLoginNotice(preset);
  assert.equal(notice.version, 2);
  for (const phrase of [
    'full control',
    'no read-only credential',
    'read-only chat operations',
    'observation',
    'restrict',
    'unknown',
    'iyear/tdl v0.20.4',
    'attributed there to iyear',
    'registrant and Telegram notification/remedy arrangements are unverified',
    'disablement may end access for every user',
    'No personal application registration',
    'does not establish Telegram permission or supplier support',
  ])
    assert.ok(notice.text.includes(phrase));
  assert.ok(!notice.text.includes("iyear's phone"));
  assert.ok(!notice.text.includes(custom.API_HASH));
  const selected = telegramApplication(preset);
  selected.apiId = 1;
  assert.notEqual(telegramApplication(preset).apiId, 1);
});

test('unknown and every partial/mixed custom setting reject before SDK transport or notice presentation', () => {
  const configs = [
    { APPLICATION_PROFILE: '' },
    { APPLICATION_PROFILE: 'desktop' },
    { APPLICATION_PROFILE: 'private-unknown-profile' },
    ...['API_ID', 'API_HASH', 'APP_OWNER'].flatMap((key) => [
      { ...preset, [key]: 'private-conflict-value' },
      { ...preset, [key]: '' },
    ]),
    { ...preset, ...custom },
  ];
  for (const config of configs) {
    const state = offlineContext();
    state.ctx.config = config;
    for (const run of [() => telegramLoginNotice(config), () => createMtcuteClient(state.ctx, blockedTransport)]) {
      assert.throws(run, (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.match(e.message, /Unknown Telegram application profile|cannot be combined/);
        assert.ok(!e.message.includes('private-'));
        return true;
      });
    }
    assert.deepEqual(state.logs, []);
    assert.deepEqual(state.saved, []);
  }
});

for (const mode of ['custom', 'tdl'] as const) {
  test(`${mode}: actual SDK auth helpers use selected identity, phone/code/password and native memory sessions offline`, async (t) => {
    const state = offlineContext();
    state.ctx.config = mode === 'custom' ? custom : preset;
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
    const restored = createMtcuteClient(state.ctx, blockedTransport);
    t.after(async () => {
      await client.sdk.stopUpdatesLoop();
      await client.sdk.destroy();
      await restored.sdk.destroy();
    });
    // Synthetic transport-created key; no account session or user credential is imported.
    await client.sdk.importSession({ authKey: new Uint8Array(256).fill(7) });
    t.mock.method(base.mt.network, 'getPrimaryDcId', () => 2);
    const calls: string[] = [];
    let deny = true;
    const proof: tl.RawInputCheckPasswordSRP = {
      _: 'inputCheckPasswordSRP',
      srpId: Long.ZERO,
      A: Buffer.alloc(1),
      M1: Buffer.alloc(1),
    };
    t.mock.method(base, 'call', async (request: tl.RpcMethod) => {
      calls.push(request._);
      switch (request._) {
        case 'auth.sendCode': {
          const identity = { apiId: request.apiId, apiHash: request.apiHash };
          if (mode === 'custom') assert.deepEqual(identity, { apiId: 123, apiHash: custom.API_HASH });
          else assert.equal(digest(identity), 'ef28f502a3e800814ad32a2261904cbe6257081baf1173d092b0f1d3b3ca2978');
          assert.equal(request.phoneNumber, '10000000000');
          if (deny) throw new tl.RpcError(400, 'API_ID_INVALID_PRIVATE_SYNTHETIC');
          return {
            _: 'auth.sentCode',
            type: { _: 'auth.sentCodeTypeApp', length: 5 },
            phoneCodeHash: 'private-code-hash',
          };
        }
        case 'auth.signIn':
          assert.equal(request.phoneCodeHash, 'private-code-hash');
          assert.equal(request.phoneCode, 'private-login-code');
          throw new tl.RpcError(401, 'SESSION_PASSWORD_NEEDED');
        case 'account.getPassword':
          return { _: 'account.password' };
        case 'auth.checkPassword':
          assert.deepEqual(request.password, proof);
          return { _: 'auth.authorization', user: { _: 'user', id: 10, self: true, firstName: 'Synthetic owner' } };
        case 'updates.getState':
          return { _: 'updates.state', pts: 1, qts: 0, date: 1800000000, seq: 1, unreadCount: 0 };
        case 'updates.getDifference':
          return { _: 'updates.differenceEmpty', date: 1800000000, seq: 1 };
        case 'auth.logOut':
          return { _: 'auth.loggedOut' };
        default:
          assert.fail(`Unexpected lower RPC ${request._}`);
      }
    });
    // SRP is a cryptographic seam only. The real checkPassword helper still requests both lower RPCs.
    t.mock.method(base, 'computeSrpParams', async (_obj, password) => {
      assert.equal(password, 'private-account-password');
      return proof;
    });
    let constructed = 0;
    const api = new MtcuteApi(state.ctx, () => {
      constructed++;
      return client;
    });
    const connector = createTelegramFactory(() => api).create(state.ctx);
    const phone = await connector.login(null);
    assert.equal(constructed, 0);
    assert.deepEqual(calls, []);
    assert.ok(phone.kind === 'need_input');
    assert.equal(phone.fields[0]?.name, 'phone');
    assert.equal((await connector.login({ phone: '+10000000000' })).kind, 'failed');
    assert.equal(calls.length, 1); // actual denial, no fallback to another application
    deny = false;
    const code = await connector.login({ phone: '+10000000000' });
    assert.ok(code.kind === 'need_input');
    assert.deepEqual(code.fields[0], { name: 'code', label: 'Login code', secret: true });
    const password = await connector.login({ code: 'private-login-code' });
    assert.ok(password.kind === 'need_input');
    assert.deepEqual(password.fields[0], { name: 'password', label: 'Account password', secret: true });
    assert.equal((await connector.login({ password: 'private-account-password' })).kind, 'done');
    assert.equal((await base.storage.self.fetch())?.userId, 10);
    await connector.stop();
    const saved = readSession(state.saved.at(-1) as string);
    await restored.sdk.importSession(saved.sdkSession as string);
    assert.equal(await restored.sdk.exportSession(), saved.sdkSession);
    assert.equal(saved.keys.size, 0);
    await connector.logout();
    assert.equal(state.saved.at(-1), null);
    assert.equal(connects, 0);
    assert.equal(constructed, 1);
    assert.equal(calls.filter((c) => c === 'auth.logOut').length, 1);
    const publicOutput = JSON.stringify({ logs: state.logs, events: state.events, phone, code, password });
    for (const secret of ['private-', custom.API_HASH, '10000000000']) assert.ok(!publicOutput.includes(secret));
    assert.ok(calls.includes('account.getPassword') && calls.includes('auth.checkPassword'));
    // Every lower call is checked by the switch; sends, read marks, typing and status writes fail there.
  });
}
