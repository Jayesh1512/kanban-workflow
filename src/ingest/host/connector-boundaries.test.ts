import assert from 'node:assert/strict';
import test from 'node:test';
import { BaseTelegramClient, tl, User } from '@mtcute/node';
import { testApp } from '../../../test/harness.ts';
import { seal } from '../../auth/index.ts';
import { loadConfig } from '../../config.ts';
import type { RecordedSession } from '../../connectors/telegram/index.ts';
import { createTelegramFactory, MtcuteApi, RecordedApi } from '../../connectors/telegram/index.ts';
import { createMtcuteClient } from '../../connectors/telegram/mtcute-client.ts';
import { blockedTransport } from '../../connectors/telegram/mtcute-test-support.ts';
import type { TgMessage } from '../../contracts/index.ts';
import { createHost } from '../host.ts';
import { getMessages } from '../index.ts';
import { connect, controlled, setup } from './test-support.ts';

test('R6.6 actual C1 host restart 300 dialogs/50 changed included chats costs 53 paced reads, unchanged restart costs only 3', async (t) => {
  const h = await testApp({ teammates: [{ username: 'alice' }] });
  const apis: RecordedApi[] = [];
  let missed = false;
  const config = loadConfig({
    KANBAN_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
    CONNECTORS: 'telegram',
    TELEGRAM_APP_OWNER: 'Synthetic owner',
  });
  const factory = createTelegramFactory((ctx) => {
    const messages: TgMessage[] = Array.from({ length: 50 }, (_, n) => ({
      id: n + 1,
      peer: { type: 'user', id: n + 20 },
      sender: { id: n + 20, displayName: `Outside ${n}`, username: null },
      date: 1788256801 + n,
      text: `synthetic ${n}`,
      media: null,
      mediaUniqueId: null,
      replyToId: null,
      editDate: null,
      isService: false,
    }));
    const source: RecordedSession = {
      self: { id: 10, displayName: 'Owner', username: null },
      updates: [],
      messages: missed ? messages : [],
      dialogs: Array.from({ length: 300 }, (_, n) => ({
        peer: { type: 'user', id: n + 20 },
        title: `Client ${n}`,
        lastMessageId: missed && n < 50 ? n + 1 : null,
        lastMessageDate: missed && n < 50 ? 1788256801 + n : null,
      })),
    };
    const api = new RecordedApi({ session: source }, ctx.now);
    apis.push(api);
    return api;
  });
  const build = () =>
    createHost({
      db: h.db,
      config,
      connectors: [factory],
      now: h.clock.now,
      sleep: async (ms) => {
        h.clock.advance(ms);
        await new Promise<void>((r) => setImmediate(r));
      },
      oplog: () => {},
    });
  let host = build();
  t.after(async () => {
    await host.stopAll();
    h.close();
  });
  const { accountId } = await host.beginLogin(h.ctxFor('alice'), 'telegram', { acknowledgedNoticeVersion: 1 });
  await host.continueLogin(h.ctxFor('alice'), accountId, { phone: '+10000000000' });
  await host.continueLogin(h.ctxFor('alice'), accountId, { code: '12345' });
  await host.startAll();
  const listing = await host.listChats(h.ctxFor('alice'), accountId);
  for (const e of listing.slice(0, 50))
    host.includeChat(h.ctxFor('alice'), accountId, e.key, { agreedWordingVersion: 1, company: null });
  await host.settle();
  await host.stopAll();
  missed = true;
  host = build();
  const at = h.clock.now().getTime();
  await host.startAll();
  await host.settle();
  const reads = apis.at(-1)?.calls.filter((c) => c.op === 'dialogs' || c.op === 'history') ?? [];
  assert.equal(reads.length, 53);
  assert.equal(reads.filter((c) => c.op === 'dialogs').length, 3);
  assert.equal(reads.filter((c) => c.op === 'history').length, 50);
  for (let i = 1; i < reads.length; i++) assert.ok((reads[i]?.atMs ?? 0) - (reads[i - 1]?.atMs ?? 0) >= 3000);
  assert.ok(h.clock.now().getTime() - at < 600000);
  assert.equal(getMessages(h.ctxFor('alice'), { limit: 100 }).length, 50);
  await host.stopAll();
  host = build();
  await host.startAll();
  await host.settle();
  assert.equal(apis.at(-1)?.calls.filter((c) => c.op === 'dialogs').length, 3);
  assert.equal(apis.at(-1)?.calls.filter((c) => c.op === 'history').length, 0);
});

test('C1 actual SDK swallowed startup auth failure surfaces through host, retains auth_lost, no connected or late state revival', async (t) => {
  const h = await testApp({ teammates: [{ username: 'alice' }] });
  const config = loadConfig({
    KANBAN_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
    CONNECTORS: 'telegram',
    TELEGRAM_API_ID: '123',
    TELEGRAM_API_HASH: 'synthetic',
    TELEGRAM_APP_OWNER: 'Owner',
  });
  let connects = 0;
  let rpcCount = 0;
  let late: ((state: 'connected') => void) | undefined;
  const factory = createTelegramFactory((ctx) => {
    const client = createMtcuteClient(ctx, {
      ...blockedTransport,
      async connect() {
        connects++;
        throw new Error('offline');
      },
    });
    const sdk = client.sdk;
    const base: unknown = Reflect.get(sdk, '_client');
    assert.ok(base instanceof BaseTelegramClient);
    const middleware = base.params.network?.middlewares?.[0];
    assert.ok(middleware);
    t.mock.method(sdk, 'connect', async () => {});
    t.mock.method(sdk, 'importSession', async () => {});
    t.mock.method(sdk, 'exportSession', async () => 'synthetic-opaque');
    t.mock.method(sdk, 'getMe', async () => new User({ _: 'user', id: 10, firstName: 'Owner', self: true }));
    t.mock.method(base, 'call', async (request: tl.RpcMethod) => {
      assert.equal(request._, 'updates.getState');
      late ??= sdk.onConnectionState.listeners()[0];
      const raw = { _: 'mt_rpc_error' as const, errorCode: 401, errorMessage: 'AUTH_KEY_UNREGISTERED' };
      assert.equal(
        await middleware({ request, manager: base.mt.network }, async () => {
          rpcCount++;
          return raw;
        }),
        raw,
      );
      throw tl.RpcError.fromTl(raw);
    });
    return new MtcuteApi(ctx, () => client);
  });
  const ctx = h.ctxFor('alice');
  assert.equal(ctx.actor.kind, 'teammate');
  h.db.tx(() =>
    h.db.run(
      "INSERT INTO channel_account(teammate_id,channel,state,session_sealed,created_at) VALUES (?,'telegram','connected',?,?)",
      ctx.actor.kind === 'teammate' ? ctx.actor.id : 0,
      seal(config.secretKey, 'synthetic-opaque'),
      h.clock.now().toISOString(),
    ),
  );
  const host = createHost({
    db: h.db,
    config,
    connectors: [factory],
    now: h.clock.now,
    sleep: async () => new Promise<void>(() => {}),
    oplog: () => {},
  });
  t.after(() => h.close());
  await assert.rejects(host.startAll(), /Account connection failed/);
  assert.equal(host.listAccounts(ctx)[0]?.state, 'auth_lost');
  late?.('connected');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(host.listAccounts(ctx)[0]?.state, 'auth_lost');
  assert.equal(host.chatCounts(ctx).connected, false);
  assert.equal(connects, 0);
  assert.ok(rpcCount >= 1 && rpcCount <= 2);
  await assert.rejects(host.stopAll(), /Account stop failed/); // Required save cannot succeed on lost authorization.
});

test('history:false gap abandons at once without calling history, and no host instance shares another listing/runtime', async (t) => {
  const r = await controlled(setup(), {
    decorate(c) {
      return {
        ...c,
        fetchHistory() {
          assert.fail('history capability false');
        },
      };
    },
  });
  // Change only this test factory metadata before a fresh real host is constructed.
  const host = createHost({
    db: r.h.db,
    config: loadConfig({ KANBAN_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'), CONNECTORS: 'fixture' }),
    connectors: [{ ...r.factory, capabilities: { ...r.factory.capabilities, history: false } }],
    now: r.h.clock.now,
    sleep: r.sleep,
    oplog: () => {},
  });
  t.after(async () => {
    await host.stopAll();
    r.h.close();
  });
  await r.control.advanceTo('setup');
  const id = await connect(host, r.ctx());
  await host.startAll();
  host.includeChat(r.ctx(), id, 'selected', { agreedWordingVersion: 1, company: null });
  await host.settle();
  assert.equal(host.listAccounts(r.ctx())[0]?.gaps[0]?.abandoned, true);
  assert.equal(r.control.calls.filter((c) => c.op === 'fetchHistory').length, 0);
  assert.equal(r.host.chatCounts(r.ctx()).undecidedRecent, null); // Independent host has no cached listing.
  assert.equal(r.h.db.get<{ sync_state: string }>('SELECT sync_state FROM account_chat')?.sync_state, 'idle');
});
