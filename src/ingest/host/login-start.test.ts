import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createModel, createMovementProvider } from '../../agent/index.ts';
import { createApp } from '../../app.ts';
import { addTeammate, open, removeTeammate, signIn } from '../../auth/index.ts';
import { loadConfig } from '../../config.ts';
import { createFixtureConnector } from '../../connectors/fixture/index.ts';
import type { Connector, ConnectorContext, Ctx } from '../../contracts/index.ts';
import { openDb } from '../../store/index.ts';
import { deferred, delivery, message, setup } from './test-support.ts';

async function freshApp(
  t: TestContext,
  decorate: (connector: Connector, ctx: ConnectorContext) => Connector = (c) => c,
) {
  const dir = mkdtempSync(join(tmpdir(), 'host-login-start-'));
  const db = openDb(join(dir, 'synthetic.db'));
  let at = Date.parse('2026-09-01T10:01:00.000Z');
  const now = () => new Date(at);
  const sleep = async (ms: number) => {
    at += ms;
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const config = loadConfig({
    KANBAN_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
    CONNECTORS: 'fixture',
    MODEL_PROVIDER: 'disabled',
    MOVEMENT_PROVIDER: 'disabled',
  });
  const fixture = createFixtureConnector({
    lines: setup(['selected'], ['alice', 'bob']).concat(
      delivery('alice', 'selected', message(1), 'history'),
      { t: 'mark', name: 'history-ready' },
      delivery('alice', 'selected', message(2)),
    ),
  });
  const contexts: ConnectorContext[] = [];
  let starts = 0;
  let noticeVersion = 1;
  const factory = {
    ...fixture.factory,
    loginNotice: () => ({ version: noticeVersion, text: 'Synthetic login notice' }),
    create(ctx: ConnectorContext) {
      contexts.push(ctx);
      const c = decorate(fixture.factory.create(ctx), ctx);
      return {
        ...c,
        async start(sink: Parameters<Connector['start']>[0]) {
          starts++;
          await c.start(sink);
        },
      };
    },
  };
  const system: Ctx = { db, now, actor: { kind: 'system' }, canReadText: true };
  const id = addTeammate(system, { username: 'alice', displayName: 'Alice', password: 'synthetic-password' });
  const ctx: Ctx = { ...system, actor: { kind: 'teammate', id } };
  const cookie = `kanban_session=${signIn(db, 'alice', 'synthetic-password', now()).token}`;
  const oplog = () => {};
  const model = await createModel(config.model, { db, oplog });
  const movement = await createMovementProvider(config.movement, {
    db,
    now,
    sleep,
    oplog,
    http: {
      async post() {
        throw new Error('External network forbidden');
      },
    },
  });
  const app = createApp({ db, now, sleep, config, model, movement, connectors: [factory], oplog });
  t.after(async () => {
    try {
      await app.stop();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  await fixture.control.advanceTo('history-ready');
  return {
    app,
    db,
    ctx,
    contexts,
    control: fixture.control,
    get starts() {
      return starts;
    },
    setNotice(version: number) {
      noticeVersion = version;
    },
    async post(path: string, form: Record<string, string>) {
      return app.fetch(
        new Request(`${config.origin}${path}`, {
          method: 'POST',
          headers: { Origin: config.origin, Cookie: cookie },
          body: new URLSearchParams(form),
        }),
      );
    },
    async get(path: string) {
      return app.fetch(new Request(`${config.origin}${path}`, { headers: { Cookie: cookie } }));
    },
  };
}

test('App started before human HTTP login imports included history and receives live messages without restart', async (t) => {
  const r = await freshApp(t);
  await r.app.start();
  assert.equal(r.starts, 0);
  assert.equal(
    (await r.post('/settings/accounts', { channel: 'fixture', acknowledgedNoticeVersion: '1' })).status,
    303,
  );
  const account = r.app.host.listAccounts(r.ctx)[0];
  assert.ok(account);
  assert.equal(r.starts, 0);
  assert.equal((await r.post(`/settings/accounts/${account.id}/login`, { account: 'alice' })).status, 303);
  const chats = await r.get(`/settings/accounts/${account.id}/chats`);
  assert.equal(chats.status, 200);
  assert.match(await chats.text(), /Title selected/);
  const sealed = r.db.get<{ session_sealed: Uint8Array }>('SELECT session_sealed FROM channel_account')?.session_sealed;
  assert.ok(sealed);
  assert.equal(open(Buffer.alloc(32, 7), sealed), 'alice');
  assert.equal(
    (
      await r.post(`/settings/accounts/${account.id}/chats/include`, {
        chatKey: 'selected',
        company: '',
        agreedWordingVersion: '1',
      })
    ).status,
    303,
  );
  await r.app.host.settle();
  assert.deepEqual(
    r.db
      .all<{ text: string; origin: string }>('SELECT text,origin FROM message ORDER BY id')
      .map((row) => ({ ...row })),
    [{ text: 'content 1', origin: 'history' }],
  );
  await r.control.advanceTo('end');
  assert.deepEqual(
    r.db
      .all<{ text: string; origin: string }>('SELECT text,origin FROM message ORDER BY id')
      .map((row) => ({ ...row })),
    [
      { text: 'content 1', origin: 'history' },
      { text: 'content 2', origin: 'live' },
    ],
  );
  assert.equal(r.starts, 1);
  assert.equal(r.db.get<{ sync_state: string }>('SELECT sync_state FROM account_chat')?.sync_state, 'idle');
  assert.equal(r.app.pipeline.status().reason, 'no_model');
  assert.equal(r.db.get<{ n: number }>('SELECT count(*) AS n FROM card')?.n, 0);
  await r.app.host.startAll();
  await r.app.host.startAll();
  assert.equal(r.starts, 1);
});

test('notice, invalid input, need_input and failed login never start or list the connector', async (t) => {
  const r = await freshApp(t);
  await r.app.start();
  await assert.rejects(r.app.host.beginLogin(r.ctx, 'fixture', { acknowledgedNoticeVersion: null }), /notice/);
  assert.equal(r.contexts.length, 0);
  const login = await r.app.host.beginLogin(r.ctx, 'fixture', { acknowledgedNoticeVersion: 1 });
  assert.equal(login.step.kind, 'need_input');
  await assert.rejects(
    Reflect.apply(r.app.host.continueLogin, null, [r.ctx, login.accountId, { account: 5 }]),
    /input/,
  );
  r.setNotice(2);
  await assert.rejects(r.app.host.continueLogin(r.ctx, login.accountId, { account: 'alice' }), /notice/);
  r.setNotice(1);
  assert.deepEqual(await r.app.host.continueLogin(r.ctx, login.accountId, { account: 'missing' }), {
    kind: 'failed',
    message: 'Account login failed',
    retryable: true,
  });
  assert.equal(r.starts, 0);
  assert.deepEqual(r.control.calls, []);
  assert.equal(r.db.get<{ session_sealed: null }>('SELECT session_sealed FROM channel_account')?.session_sealed, null);
});

test('beginLogin that completes immediately also activates only after sealed identity binding', async (t) => {
  const r = await freshApp(t, (c) => ({
    ...c,
    login: (input) => c.login(input ?? { account: 'alice' }),
    async start(sink) {
      assert.ok(
        r.db.get('SELECT id FROM channel_account WHERE self_identity_id IS NOT NULL AND session_sealed IS NOT NULL'),
      );
      await c.start(sink);
    },
  }));
  await r.app.start();
  const login = await r.app.host.beginLogin(r.ctx, 'fixture', { acknowledgedNoticeVersion: 1 });
  assert.equal(login.step.kind, 'done');
  assert.equal(r.starts, 1);
  assert.equal(r.app.host.chatCounts(r.ctx).connected, true);
});

test('login before initial App startup defers activation; restored startAll remains idempotent', async (t) => {
  const r = await freshApp(t);
  const login = await r.app.host.beginLogin(r.ctx, 'fixture', { acknowledgedNoticeVersion: 1 });
  assert.equal((await r.app.host.continueLogin(r.ctx, login.accountId, { account: 'alice' })).kind, 'done');
  assert.equal(r.starts, 0);
  await r.app.start();
  await r.app.host.startAll();
  assert.equal(r.starts, 1);
  assert.equal(r.app.host.chatCounts(r.ctx).connected, true);
});

for (const cancel of ['stop', 'owner removal'] as const) {
  test(`pending human login cannot start or save after ${cancel}`, async (t) => {
    const entered = deferred();
    const release = deferred();
    const r = await freshApp(t, (c) => ({
      ...c,
      async login(input) {
        if (input !== null) {
          entered.resolve();
          await release.promise;
        }
        return c.login(input);
      },
    }));
    await r.app.start();
    const login = await r.app.host.beginLogin(r.ctx, 'fixture', { acknowledgedNoticeVersion: 1 });
    const result = assert.rejects(
      r.app.host.continueLogin(r.ctx, login.accountId, { account: 'alice' }),
      /login failed/,
    );
    await entered.promise;
    if (cancel === 'stop') await r.app.stop();
    else {
      const bob = addTeammate(
        { ...r.ctx, actor: { kind: 'system' } },
        {
          username: 'bob',
          displayName: 'Bob',
          password: 'synthetic-password',
        },
      );
      assert.equal(r.ctx.actor.kind, 'teammate');
      await removeTeammate(
        { ...r.ctx, actor: { kind: 'teammate', id: bob } },
        r.ctx.actor.kind === 'teammate' ? r.ctx.actor.id : 0,
        (id) => r.app.host.disconnect({ ...r.ctx, actor: { kind: 'system' } }, id),
      );
    }
    release.resolve();
    await result;
    assert.equal(r.starts, 0);
    assert.deepEqual(r.control.calls, []);
    assert.equal(
      r.db.get<{ session_sealed: null }>('SELECT session_sealed FROM channel_account')?.session_sealed,
      null,
    );
  });
}

test('relogin rejects a different authenticated self before starting and preserves the original identity', async (t) => {
  const r = await freshApp(t);
  await r.app.start();
  const first = await r.app.host.beginLogin(r.ctx, 'fixture', { acknowledgedNoticeVersion: 1 });
  await r.app.host.continueLogin(r.ctx, first.accountId, { account: 'alice' });
  const identity = r.db.get<{ self_identity_id: number }>(
    'SELECT self_identity_id FROM channel_account',
  )?.self_identity_id;
  await r.app.host.beginLogin(r.ctx, 'fixture', { acknowledgedNoticeVersion: 1 });
  await assert.rejects(r.app.host.continueLogin(r.ctx, first.accountId, { account: 'bob' }), /login failed/);
  assert.equal(r.starts, 1);
  assert.deepEqual(
    {
      ...r.db.get<{ state: string; session_sealed: Uint8Array | null; self_identity_id: number }>(
        'SELECT state,session_sealed,self_identity_id FROM channel_account',
      ),
    },
    {
      state: 'disconnected',
      session_sealed: null,
      self_identity_id: identity,
    },
  );
});

test('startup failure reports disconnected despite failed cleanup; explicit relogin uses a fresh runtime once', async (t) => {
  let fail = true;
  const r = await freshApp(t, (c) => {
    const broken = fail;
    fail = false;
    return {
      ...c,
      async start(sink) {
        await c.start(sink);
        if (broken) throw new Error('synthetic start failure');
      },
      async stop() {
        await c.stop();
        if (broken) throw new Error('synthetic cleanup failure');
      },
    };
  });
  await r.app.start();
  const login = await r.app.host.beginLogin(r.ctx, 'fixture', { acknowledgedNoticeVersion: 1 });
  await assert.rejects(
    r.app.host.continueLogin(r.ctx, login.accountId, { account: 'alice' }),
    /Account connection failed/,
  );
  assert.equal(r.db.get<{ state: string }>('SELECT state FROM channel_account')?.state, 'disconnected');
  assert.equal(r.app.host.chatCounts(r.ctx).connected, false);
  // beginLogin retains its existing stop-error propagation, while retiring the faulted runtime.
  await assert.rejects(
    r.app.host.beginLogin(r.ctx, 'fixture', { acknowledgedNoticeVersion: 1 }),
    /session no longer active/,
  );
  await r.app.host.beginLogin(r.ctx, 'fixture', { acknowledgedNoticeVersion: 1 });
  await r.app.host.continueLogin(r.ctx, login.accountId, { account: 'alice' });
  assert.equal(r.starts, 2);
  assert.equal(r.contexts.length, 2);
  assert.throws(() => r.contexts[0]?.saveSession('stale synthetic session'), /no longer active/);
  await r.app.host.startAll();
  assert.equal(r.starts, 2);
});

test('stop during newly activated startup fences late completion and repeated stop stays bounded', async (t) => {
  const entered = deferred();
  const release = deferred();
  const r = await freshApp(t, (c) => ({
    ...c,
    async start(sink) {
      await c.start(sink);
      entered.resolve();
      await release.promise;
    },
  }));
  await r.app.start();
  const login = await r.app.host.beginLogin(r.ctx, 'fixture', { acknowledgedNoticeVersion: 1 });
  const result = assert.rejects(
    r.app.host.continueLogin(r.ctx, login.accountId, { account: 'alice' }),
    /login cancelled/,
  );
  await entered.promise;
  await r.app.stop();
  await r.app.host.stopAll();
  release.resolve();
  await result;
  assert.equal(r.starts, 1);
  assert.equal(r.app.host.chatCounts(r.ctx).connected, false);
  assert.deepEqual(r.control.calls, []);
  await r.control.advanceTo('end');
  assert.deepEqual(r.db.all('SELECT * FROM message'), []);
});

test('relogin during startup replaces its runtime; late old startup cannot deliver or overwrite the successor', async (t) => {
  const entered = deferred();
  const release = deferred();
  let first = true;
  const r = await freshApp(t, (c) => {
    const held = first;
    first = false;
    return {
      ...c,
      async start(sink) {
        await c.start(sink);
        if (held) {
          entered.resolve();
          await release.promise;
        }
      },
    };
  });
  await r.app.start();
  const login = await r.app.host.beginLogin(r.ctx, 'fixture', { acknowledgedNoticeVersion: 1 });
  const old = assert.rejects(r.app.host.continueLogin(r.ctx, login.accountId, { account: 'alice' }), /login cancelled/);
  await entered.promise;
  await r.app.host.beginLogin(r.ctx, 'fixture', { acknowledgedNoticeVersion: 1 });
  assert.equal((await r.app.host.continueLogin(r.ctx, login.accountId, { account: 'alice' })).kind, 'done');
  r.app.host.includeChat(r.ctx, login.accountId, 'selected', { agreedWordingVersion: 1, company: null });
  await r.app.host.settle();
  release.resolve();
  await old;
  assert.throws(() => r.contexts[0]?.saveSession(null), /no longer active/);
  await r.control.advanceTo('end');
  assert.equal(r.starts, 2);
  assert.equal(r.app.host.chatCounts(r.ctx).connected, true);
  assert.deepEqual(
    r.db.all<{ origin: string }>('SELECT origin FROM message ORDER BY id').map((m) => m.origin),
    ['history', 'live'],
  );
});
