import assert from 'node:assert/strict';
import test from 'node:test';
import { testApp } from '../../../test/harness.ts';
import { open, seal } from '../../auth/index.ts';
import { loadConfig } from '../../config.ts';
import type { RecordedSession } from '../../connectors/telegram/index.ts';
import { createTelegramFactory, RecordedApi } from '../../connectors/telegram/index.ts';
import type { ConnectorContext, Ctx, OpLog, TgMessage } from '../../contracts/index.ts';
import { history } from '../../log/index.ts';
import { openDb } from '../../store/index.ts';
import { createHost } from '../host.ts';
import { getMessages } from '../index.ts';
import { deferred } from './test-support.ts';

const key = Buffer.alloc(32, 7);
function source(): RecordedSession {
  const m: TgMessage = {
    id: 1,
    peer: { type: 'user', id: 20 },
    sender: { id: 20, displayName: 'Outside', username: 'outside' },
    date: 1788256801,
    text: 'synthetic original text',
    media: null,
    mediaUniqueId: null,
    replyToId: null,
    editDate: null,
    isService: false,
  };
  return {
    self: { id: 10, displayName: 'Owner', username: 'owner' },
    dialogs: [{ peer: m.peer, title: 'Synthetic client', lastMessageId: 1, lastMessageDate: m.date }],
    messages: [m],
    updates: [{ type: 'new', message: m }],
  };
}
async function sessionRig() {
  const h = await testApp({ teammates: [{ username: 'alice' }, { username: 'bob' }] });
  const file = h.db.get<{ file: string }>('PRAGMA database_list')?.file;
  assert.ok(file);
  let db = openDb(file);
  const apis: RecordedApi[] = [];
  const saved: (string | null)[] = [];
  const contexts: ConnectorContext[] = [];
  const ops: { event: string; fields: unknown }[] = [];
  const oplog: OpLog = (_level, event, fields) => {
    ops.push({ event, fields });
  };
  let revision = source();
  const config = loadConfig({
    KANBAN_SECRET_KEY: key.toString('base64'),
    CONNECTORS: 'telegram',
    TELEGRAM_APP_OWNER: 'Named Owner',
  });
  const factory = createTelegramFactory((ctx) => {
    const api = new RecordedApi({ session: revision }, ctx.now);
    apis.push(api);
    return api;
  });
  const wrapped = {
    ...factory,
    create(ctx: ConnectorContext) {
      contexts.push(ctx);
      return factory.create({
        ...ctx,
        saveSession(value) {
          ctx.saveSession(value);
          const stored = db.get<{ session_sealed: Uint8Array | null }>(
            'SELECT session_sealed FROM channel_account WHERE id=?',
            ctx.accountId,
          )?.session_sealed;
          if (value === null) assert.equal(stored, null);
          else {
            assert.ok(stored);
            assert.equal(open(key, stored), value);
          }
          saved.push(value);
        },
      });
    },
  };
  const build = () =>
    createHost({
      db,
      config,
      connectors: [wrapped],
      now: h.clock.now,
      sleep: async (ms) => {
        h.clock.advance(ms);
        await new Promise<void>((r) => setImmediate(r));
      },
      oplog,
    });
  return {
    h,
    file,
    apis,
    contexts,
    saved,
    ops,
    build,
    ctx: (name = 'alice'): Ctx => ({ ...h.ctxFor(name), db }),
    get db() {
      return db;
    },
    reopen() {
      db.close();
      db = openDb(file);
    },
    revision(value: RecordedSession) {
      revision = value;
    },
    close() {
      db.close();
      h.close();
    },
  };
}
async function login(r: Awaited<ReturnType<typeof sessionRig>>, host: ReturnType<typeof createHost>) {
  const { accountId } = await host.beginLogin(r.ctx(), 'telegram', { acknowledgedNoticeVersion: 1 });
  assert.equal((await host.continueLogin(r.ctx(), accountId, { phone: '+10000000000' })).kind, 'need_input');
  assert.equal((await host.continueLogin(r.ctx(), accountId, { code: '12345' })).kind, 'done');
  return accountId;
}

test('R4.5 full three-fact versioned owner-naming notice enforced before any actual C1 login call', async (t) => {
  const r = await sessionRig();
  const host = r.build();
  t.after(async () => {
    await host.stopAll();
    r.close();
  });
  const notice = host.listChannels()[0]?.loginNotice;
  assert.equal(notice?.version, 1);
  assert.match(notice?.text ?? '', /full control.*no read-only/);
  assert.match(notice?.text ?? '', /observation.*restrict.*unknown/);
  assert.match(notice?.text ?? '', /Named Owner.*phone number.*notifies.*every teammate/);
  for (const version of [null, 2])
    await assert.rejects(
      host.beginLogin(r.ctx(), 'telegram', { acknowledgedNoticeVersion: version }),
      /acknowledgement/,
    );
  assert.equal(r.apis.length, 0);
  assert.equal(r.db.get<{ n: number }>('SELECT count(*) AS n FROM channel_account')?.n, 0);
  const id = await login(r, host);
  const log = history(r.ctx(), { action: 'account.acknowledge' })[0];
  assert.ok(log);
  assert.equal(log?.actor.name, 'alice');
  assert.equal((log.after as { noticeVersion: number }).noticeVersion, 1);
  assert.equal(host.listAccounts(r.ctx('bob')).length, 0);
  await assert.rejects(host.continueLogin(r.ctx('bob'), id, {}), /owner required/);
});

test('actual C1 canonical envelope atomically whole-string sealed before return, retained after file reopen and first edited history', async (t) => {
  const r = await sessionRig();
  let host = r.build();
  t.after(async () => {
    await host.stopAll();
    r.close();
  });
  const id = await login(r, host);
  await host.startAll();
  const listing = await host.listChats(r.ctx(), id);
  assert.ok(listing[0]);
  host.includeChat(r.ctx(), id, listing[0].key, { agreedWordingVersion: 1, company: null });
  await host.settle();
  const original = getMessages(r.ctx(), {})[0];
  assert.ok(original);
  const sealed = r.db.get<{ session_sealed: Uint8Array }>(
    'SELECT session_sealed FROM channel_account WHERE id=?',
    id,
  )?.session_sealed;
  assert.ok(sealed);
  const entire = open(key, sealed);
  assert.ok(entire.startsWith('kanban:telegram-session:'));
  assert.doesNotMatch(Buffer.from(sealed).toString('utf8'), /kanban:telegram-session|sdkSession|synthetic original/);
  assert.doesNotMatch(JSON.stringify(r.ops), /sdkSession|kanban:telegram-session|synthetic original|Named Owner/);
  const firstKey = r.db.get<{ message_key: string }>('SELECT message_key FROM message')?.message_key;
  await host.stopAll();
  r.reopen();
  const revised = source();
  assert.ok(revised.messages[0]);
  revised.messages[0] = {
    ...revised.messages[0],
    text: 'synthetic edited text',
    editDate: revised.messages[0].date + 10,
  };
  assert.ok(revised.dialogs[0]);
  revised.dialogs[0] = { ...revised.dialogs[0], lastMessageId: 2 }; // metadata service cursor forces history replay.
  revised.updates = [{ type: 'edit', message: revised.messages[0] }];
  r.revision(revised);
  host = r.build();
  await host.startAll();
  await host.settle();
  await r.apis.at(-1)?.advanceTo('end');
  assert.equal(getMessages(r.ctx(), {}).length, 1);
  assert.equal(getMessages(r.ctx(), {})[0]?.text, original.text); // H2 storage deliberately not admitted.
  assert.equal(r.db.get<{ message_key: string }>('SELECT message_key FROM message')?.message_key, firstKey);
  const restored = r.db.get<{ session_sealed: Uint8Array }>(
    'SELECT session_sealed FROM channel_account',
  )?.session_sealed;
  assert.ok(restored);
  assert.equal(open(key, restored), r.saved.at(-1));
  assert.ok(r.apis.at(-1)?.calls.some((c) => c.op === 'importSession'));
});

test('host tampered sealed/envelope sessions fail safely; genuine C1 save fault cannot report successful login', async (t) => {
  const r = await sessionRig();
  let host = r.build();
  t.after(() => r.close());
  const id = await login(r, host);
  await host.stopAll();
  const saved = r.db.get<{ session_sealed: Uint8Array }>('SELECT session_sealed FROM channel_account')?.session_sealed;
  assert.ok(saved);
  const tampered = Buffer.from(saved);
  tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1;
  r.db.tx(() => r.db.run('UPDATE channel_account SET session_sealed=?', tampered));
  host = r.build();
  await assert.rejects(host.startAll(), /Account connection failed/);
  assert.notEqual(r.db.get<{ state: string }>('SELECT state FROM channel_account')?.state, 'connected');
  await host.stopAll();
  r.db.tx(() =>
    r.db.run(
      "UPDATE channel_account SET state='disconnected',session_sealed=?",
      seal(key, 'kanban:telegram-session:{"v":2}'),
    ),
  );
  host = r.build();
  const calls = r.apis.length;
  await assert.rejects(host.startAll(), /Account connection failed/);
  assert.ok(r.apis[calls]?.calls.every((c) => c.op === 'destroy')); // No import/decode/login/read before strict validation; cleanup is allowed.
  await assert.rejects(host.stopAll(), /Account stop failed/);
  // New actual C1 login, using a real DB write failure rather than a fake login result.
  r.db.tx(() => r.db.run("UPDATE channel_account SET state='removed',session_sealed=NULL WHERE id=?", id));
  host = r.build();
  await host.beginLogin(r.ctx(), 'telegram', { acknowledgedNoticeVersion: 1 });
  await host.continueLogin(r.ctx(), id, { phone: '+10000000000' });
  const run = r.db.run.bind(r.db);
  r.db.run = (sql, ...params) => {
    if (sql.startsWith('UPDATE channel_account SET session_sealed=') && params[0] !== null)
      throw new Error('SYNTHETIC_SECRET_STORE_FAILURE');
    return run(sql, ...params);
  };
  await assert.rejects(
    host.continueLogin(r.ctx(), id, { code: '12345' }),
    (e: unknown) => e instanceof Error && e.message === 'Account login failed',
  );
  assert.notEqual(r.db.get<{ state: string }>('SELECT state FROM channel_account')?.state, 'connected');
  assert.equal(
    r.db.get<{ session_sealed: Uint8Array | null }>('SELECT session_sealed FROM channel_account')?.session_sealed,
    null,
  );
  assert.doesNotMatch(JSON.stringify(r.ops), /SYNTHETIC_SECRET_STORE_FAILURE|sdkSession/);
  r.db.run = run;
  await assert.rejects(host.stopAll(), /Account stop failed/); // C1 persistence failure is latched and cannot impersonate success.
});

test('actual C1 startup pending-key save fault rejects awaited host start, old sealed state retained, no successful/late connected state', async (t) => {
  const r = await sessionRig();
  const host = r.build();
  t.after(() => r.close());
  await login(r, host);
  const api = r.apis[0];
  assert.ok(api);
  const entered = deferred();
  const release = deferred();
  let handlers: Parameters<RecordedApi['startUpdates']>[0] | undefined;
  const start = api.startUpdates.bind(api);
  api.startUpdates = async (h) => {
    handlers = h;
    await start(h);
    entered.resolve();
    await release.promise;
  };
  const before = r.db.get<{ session_sealed: Uint8Array }>('SELECT session_sealed FROM channel_account')?.session_sealed;
  assert.ok(before);
  const pending = host.startAll();
  const rejection = assert.rejects(pending, /Account connection failed/);
  await entered.promise;
  const run = r.db.run.bind(r.db);
  r.db.run = (sql, ...params) => {
    if (sql.startsWith('UPDATE channel_account SET session_sealed=') && params[0] !== null)
      throw new Error('SYNTHETIC_START_SECRET_FAILURE');
    return run(sql, ...params);
  };
  assert.ok(handlers);
  const m = source().messages[0];
  assert.ok(m);
  await assert.rejects(handlers.onNew(m), /Connector session persistence failed/);
  release.resolve();
  await rejection;
  handlers.onState('connected');
  await Promise.resolve();
  assert.equal(host.listAccounts(r.ctx())[0]?.state, 'disconnected');
  assert.deepEqual(
    r.db.get<{ session_sealed: Uint8Array }>('SELECT session_sealed FROM channel_account')?.session_sealed,
    before,
  );
  assert.equal(getMessages(r.ctx(), {}).length, 0);
  assert.doesNotMatch(JSON.stringify(r.ops), /SYNTHETIC_START_SECRET_FAILURE|sdkSession/);
  r.db.run = run;
  await assert.rejects(host.stopAll(), /Account stop failed/);
});

test('cold disconnect destroys reopened sealed state synchronously and invokes the opaque C1 logout boundary', async (t) => {
  const r = await sessionRig();
  let host = r.build();
  t.after(async () => {
    await host.stopAll();
    r.close();
  });
  const id = await login(r, host);
  await host.stopAll();
  r.reopen();
  host = r.build();
  const at = r.h.clock.now().getTime();
  await host.disconnect(r.ctx(), id);
  assert.equal(
    r.db.get<{ session_sealed: Uint8Array | null }>('SELECT session_sealed FROM channel_account')?.session_sealed,
    null,
  );
  assert.equal(host.listAccounts(r.ctx())[0]?.state, 'removed');
  assert.ok(r.h.clock.now().getTime() - at < 60000);
  assert.ok(r.apis.at(-1)?.calls.some((c) => c.op === 'logOut'));
  const calls = r.apis.at(-1)?.calls.map((c) => c.op) ?? [];
  assert.equal(calls.filter((op) => op === 'importSession').length, 1);
  assert.ok(calls.indexOf('importSession') < calls.indexOf('logOut'));
  assert.equal(calls.includes('getMe'), false);
  assert.equal(calls.includes('exportSession'), false);
  assert.ok(calls.includes('destroy'));
});
