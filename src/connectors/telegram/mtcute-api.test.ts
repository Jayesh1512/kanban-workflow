import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryStorageDriver, TelegramClient, tl, User } from '@mtcute/node';
import { TgFloodWait } from '../../contracts/index.ts';
import { createTelegramFactory } from './connector.ts';
import { MtcuteApi } from './mtcute-api.ts';
import { createMtcuteClient } from './mtcute-client.ts';
import { sdkData } from './mtcute-test-data.ts';
import { blockedTransport, offlineContext } from './mtcute-test-support.ts';
import { readSession } from './session-state.ts';

test('R4.6 source-informed offline SDK construction: real MemoryStorage export/import and no socket or native SQLite', async () => {
  const state = offlineContext();
  const first = createMtcuteClient(state.ctx, blockedTransport);
  const second = createMtcuteClient(state.ctx, blockedTransport);
  assert.ok(first.sdk instanceof TelegramClient && second.sdk instanceof TelegramClient);
  assert.ok(first.storage.driver instanceof MemoryStorageDriver);
  await first.sdk.importSession({
    authKey: new Uint8Array(256).fill(7),
    self: { userId: 10, isBot: false, isPremium: false, usernames: [] },
  });
  const session = await first.sdk.exportSession();
  assert.equal(typeof session, 'string');
  await second.sdk.importSession(session);
  assert.equal(await second.sdk.exportSession(), session);
  assert.equal(first.sdk.onNewMessage.length, 0);
  assert.deepEqual(state.events, []);
  await first.sdk.destroy();
  await second.sdk.destroy();
});

test('Actual MtcuteApi login phone/code/password, flood translation and null logout through neutral connector', async (t) => {
  const state = offlineContext();
  const data = sdkData();
  const client = createMtcuteClient(state.ctx, blockedTransport);
  const user = new User(data.users[0] as tl.RawUser);
  const calls: string[] = [];
  t.mock.method(client.sdk, 'sendCode', async () => {
    calls.push('auth.sendCode');
    return { phoneCodeHash: 'synthetic-hash' };
  });
  t.mock.method(client.sdk, 'signIn', async () => {
    calls.push('auth.signIn');
    throw new tl.RpcError(401, 'SESSION_PASSWORD_NEEDED');
  });
  t.mock.method(client.sdk, 'checkPassword', async () => {
    calls.push('auth.checkPassword');
    return user;
  });
  t.mock.method(client.sdk, 'exportSession', async () => 'synthetic-opaque');
  t.mock.method(client.sdk, 'logOut', async () => {
    calls.push('auth.logOut');
  });
  const api = new MtcuteApi(state.ctx, () => client);
  const connector = createTelegramFactory(() => api).create(state.ctx);
  assert.equal((await connector.login(null)).kind, 'need_input');
  assert.equal((await connector.login({ phone: '+10000000000' })).kind, 'need_input');
  const step = await connector.login({ code: 'synthetic' });
  assert.ok(step.kind === 'need_input');
  assert.equal(step.fields[0]?.name, 'password');
  assert.equal((await connector.login({ password: 'synthetic' })).kind, 'done');
  assert.equal(readSession(state.saved.at(-1) as string).sdkSession, 'synthetic-opaque');
  assert.equal(readSession(state.saved.at(-1) as string).keys.size, 0);
  client.dialogs = async () => {
    throw new tl.RpcError(420, 'FLOOD_WAIT_601');
  };
  await assert.rejects(api.dialogs({ offset: null, limit: 100 }), (e) => e instanceof TgFloodWait && e.seconds === 601);
  await connector.logout();
  assert.equal(state.saved.at(-1), null);
  assert.deepEqual(calls, ['auth.sendCode', 'auth.signIn', 'auth.checkPassword', 'auth.logOut']);
});
