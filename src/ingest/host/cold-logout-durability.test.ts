import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { addTeammate, seal } from '../../auth/index.ts';
import { loadConfig } from '../../config.ts';
import { createTelegramFactory, RecordedApi } from '../../connectors/telegram/index.ts';
import type { ConnectorContext, Ctx } from '../../contracts/index.ts';
import { openDb } from '../../store/index.ts';
import { createHost } from '../host.ts';
import { assertNoHandles, exclusiveFile } from './durability-support.ts';
import { deferred } from './test-support.ts';

for (const scenario of [
  'canonical',
  'legacy',
  'null',
  'malformed',
  'import-error',
  'rpc-error',
  'cancel-import',
] as const)
  test(`actual file-backed cold Host→opaque C1 disconnect ${scenario}: import-before-strict-auth-RPC, removal/fence/safe cleanup`, async (t) => {
    const f = exclusiveFile();
    let db = openDb(f.path);
    let time = Date.parse('2026-09-01T10:00:00.000Z');
    const now = () => new Date(time);
    const key = Buffer.alloc(32, 7);
    const config = loadConfig({
      KANBAN_SECRET_KEY: key.toString('base64'),
      CONNECTORS: 'telegram',
      TELEGRAM_APP_OWNER: 'Named Owner',
    });
    const source = {
      self: { id: 10, displayName: 'Synthetic owner', username: 'owner' },
      dialogs: [],
      messages: [],
      updates: [],
    };
    const contexts: ConnectorContext[] = [];
    const apis: RecordedApi[] = [];
    let cold = false;
    const held = deferred();
    const imported = deferred();
    class StrictApi extends RecordedApi {
      override async importSession(value: string) {
        await super.importSession(value);
        if (cold && scenario === 'import-error') throw new Error('IMPORT_RAW_SECRET');
        if (cold && scenario === 'cancel-import') {
          imported.resolve();
          await held.promise;
        }
      }
      override async logOut() {
        // Actual RecordedApi itself enforces authenticated state. This seam does not revoke a remote account.
        await super.logOut();
        if (cold && scenario === 'rpc-error') throw new Error('RPC_RAW_SECRET');
      }
    }
    const raw = createTelegramFactory(() => {
      const api = new StrictApi({ session: source }, now);
      apis.push(api);
      return api;
    });
    const factory = {
      ...raw,
      create(ctx: ConnectorContext) {
        contexts.push(ctx);
        return raw.create(ctx);
      },
    };
    const waits: { ms: number; resolve: () => void }[] = [];
    const sleep = (ms: number) => new Promise<void>((resolve) => waits.push({ ms, resolve }));
    const build = () => createHost({ db, now, sleep, config, connectors: [factory], oplog: () => {} });
    let host = build();
    const system: Ctx = { db, now, actor: { kind: 'system' }, canReadText: true };
    const owner = addTeammate(system, { username: 'alice', displayName: 'alice', password: 'synthetic-password' });
    const ctx = (): Ctx => ({ ...system, db, actor: { kind: 'teammate', id: owner } });
    t.after(async () => {
      held.resolve();
      for (const wait of waits) wait.resolve();
      await host.stopAll();
      db.close();
      assertNoHandles(f.path);
      rmSync(f.directory, { recursive: true, force: true });
    });
    const { accountId } = await host.beginLogin(ctx(), 'telegram', { acknowledgedNoticeVersion: 1 });
    await host.continueLogin(ctx(), accountId, { phone: '+10000000000' });
    assert.equal((await host.continueLogin(ctx(), accountId, { code: '12345' })).kind, 'done');
    await host.stopAll();
    if (scenario === 'legacy')
      db.run(
        'UPDATE channel_account SET session_sealed=? WHERE id=?',
        seal(key, JSON.stringify({ v: 1, selfId: 10 })),
        accountId,
      );
    if (scenario === 'null') db.run('UPDATE channel_account SET session_sealed=NULL WHERE id=?', accountId);
    if (scenario === 'malformed')
      db.run(
        'UPDATE channel_account SET session_sealed=? WHERE id=?',
        seal(key, 'kanban:telegram-session:{"v":999}'),
        accountId,
      );
    db.close();
    assertNoHandles(f.path);
    db = openDb(f.path);
    cold = true;
    host = build();
    const oldCount = apis.length;
    const at = time;
    const removal = host.disconnect(ctx(), accountId);
    assert.equal(db.get<{ state: string; session_sealed: null }>('SELECT * FROM channel_account')?.state, 'removed');
    assert.equal(db.get<{ session_sealed: null }>('SELECT * FROM channel_account')?.session_sealed, null);
    if (scenario === 'cancel-import') {
      const rejection = assert.rejects(removal, /Account removed; remote logout failed/);
      await imported.promise;
      for (let n = 0; n < 150; n++) await Promise.resolve();
      const timer = waits.find((w) => w.ms === 45000);
      assert.ok(timer);
      time += 45000;
      timer.resolve();
      await rejection;
      const before = apis.at(-1)?.calls.map((c) => c.op);
      held.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(
        apis.at(-1)?.calls.map((c) => c.op),
        before,
      );
    } else if (['malformed', 'import-error', 'rpc-error'].includes(scenario))
      await assert.rejects(removal, /Account removed; remote logout (restoration )?failed/);
    else await removal;
    assert.ok(time - at < 60000);
    const coldApi = apis.length > oldCount ? apis.at(-1) : undefined;
    const calls = coldApi?.calls.map((c) => c.op) ?? [];
    if (scenario === 'canonical' || scenario === 'legacy' || scenario === 'rpc-error') {
      assert.equal(calls.filter((op) => op === 'importSession').length, 1);
      assert.ok(calls.indexOf('importSession') < calls.indexOf('logOut'));
      assert.ok(calls.includes('destroy'));
    }
    if (scenario === 'null' || scenario === 'malformed') {
      assert.equal(calls.includes('importSession'), false);
      assert.equal(calls.includes('logOut'), false);
    }
    if (scenario === 'import-error' || scenario === 'cancel-import') {
      assert.equal(calls.includes('logOut'), false);
      assert.ok(calls.includes('destroy'));
    }
    for (const op of ['getMe', 'sendCode', 'signIn', 'startUpdates', 'exportSession'])
      assert.equal(calls.includes(op as (typeof calls)[number]), false);
    if (coldApi) {
      const saved = contexts.at(-1);
      assert.ok(saved);
      assert.throws(() => saved.saveSession('NONNULL_REMOVAL_MARKER'), /no longer active/);
    }
    assert.equal(db.get<{ session_sealed: null }>('SELECT session_sealed FROM channel_account')?.session_sealed, null);
    assert.doesNotMatch(
      JSON.stringify(db.all('SELECT * FROM action_log')),
      /IMPORT_RAW_SECRET|RPC_RAW_SECRET|NONNULL_REMOVAL_MARKER|sdkSession/,
    );
  });
