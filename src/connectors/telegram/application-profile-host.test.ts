import assert from 'node:assert/strict';
import test from 'node:test';
import { testApp } from '../../../test/harness.ts';
import { open } from '../../auth/index.ts';
import { loadConfig } from '../../config.ts';
import { createHost } from '../../ingest/index.ts';
import { history } from '../../log/index.ts';
import { createTelegramFactory } from './connector.ts';
import { RecordedApi } from './recorded-api.ts';
import { readSession } from './session-state.ts';

test('existing Host enforces notice2 before creation and phone/code/password, and rejects an old version1 acknowledgement', async (t) => {
  const h = await testApp({ teammates: [{ username: 'alice' }] });
  const key = Buffer.alloc(32, 7);
  const config = loadConfig({
    KANBAN_SECRET_KEY: key.toString('base64'),
    CONNECTORS: 'telegram',
    TELEGRAM_APPLICATION_PROFILE: 'custom',
    TELEGRAM_API_ID: '123',
    TELEGRAM_API_HASH: 'synthetic',
    TELEGRAM_APP_OWNER: 'Named Owner',
    MODEL_PROVIDER: 'disabled',
    MOVEMENT_PROVIDER: 'disabled',
  });
  const apis: RecordedApi[] = [];
  const factory = createTelegramFactory((ctx) => {
    const api = new RecordedApi(
      {
        session: {
          self: { id: 10, displayName: 'Synthetic owner', username: null },
          passwordNeeded: true,
          dialogs: [],
          messages: [],
          updates: [],
        },
      },
      ctx.now,
    );
    apis.push(api);
    return api;
  });
  const host = createHost({
    db: h.db,
    config,
    connectors: [factory],
    now: h.clock.now,
    sleep: async (ms) => h.clock.advance(ms),
    oplog: () => {},
  });
  t.after(async () => {
    await host.stopAll();
    await h.app.stop();
    h.close();
  });
  const ctx = h.ctxFor('alice');
  const old = await host.beginLogin(ctx, 'telegram', { acknowledgedNoticeVersion: 1 });
  assert.equal(apis[0]?.calls.length, 0);
  // The same saved acknowledgement is insufficient after explicit profile/version change.
  config.connectors.telegram = { APPLICATION_PROFILE: 'tdl' };
  assert.equal(host.listChannels()[0]?.loginNotice?.version, 2);
  await assert.rejects(host.continueLogin(ctx, old.accountId, { phone: '+10000000000' }), /acknowledgement/);
  assert.equal(apis[0]?.calls.length, 0);
  for (const version of [null, 1])
    await assert.rejects(host.beginLogin(ctx, 'telegram', { acknowledgedNoticeVersion: version }), /acknowledgement/);
  assert.equal(apis.length, 1);
  await host.disconnect(ctx, old.accountId);
  const { accountId, step } = await host.beginLogin(ctx, 'telegram', { acknowledgedNoticeVersion: 2 });
  assert.ok(step.kind === 'need_input');
  assert.equal(step.fields[0]?.name, 'phone');
  assert.equal(apis.length, 2);
  assert.equal(apis[1]?.calls.length, 0);
  const ack = history(ctx, { action: 'account.acknowledge' }).find((entry) => entry.subjectId === accountId);
  assert.ok(ack);
  assert.equal((ack.after as { noticeVersion: number }).noticeVersion, 2);
  const code = await host.continueLogin(ctx, accountId, { phone: '+10000000000' });
  assert.ok(code.kind === 'need_input' && code.fields[0]?.name === 'code');
  const password = await host.continueLogin(ctx, accountId, { code: 'synthetic-code' });
  assert.ok(password.kind === 'need_input' && password.fields[0]?.name === 'password');
  assert.equal((await host.continueLogin(ctx, accountId, { password: 'synthetic-password' })).kind, 'done');
  const row = h.db.get<{ session_sealed: Uint8Array }>(
    'SELECT session_sealed FROM channel_account WHERE id=?',
    accountId,
  );
  assert.ok(row?.session_sealed);
  assert.ok(readSession(open(key, row.session_sealed)).sdkSession);
  assert.deepEqual(
    apis[1]?.calls.map((call) => call.op),
    ['sendCode', 'signIn', 'checkPassword', 'exportSession'],
  );
});
