import assert from 'node:assert/strict';
import test from 'node:test';
import { open } from '../../auth/index.ts';
import type { ConnectorContext } from '../../contracts/index.ts';
import { AppError } from '../../contracts/index.ts';
import { durabilityRig } from './durability-support.ts';
import { connect, deferred, message } from './test-support.ts';

const removed = (r: Awaited<ReturnType<typeof durabilityRig>>) => {
  assert.equal(r.db.get<{ state: string }>('SELECT state FROM channel_account')?.state, 'removed');
  assert.equal(r.db.get<{ session_sealed: null }>('SELECT session_sealed FROM channel_account')?.session_sealed, null);
  const row = r.db.get<Record<string, unknown>>('SELECT * FROM account_chat');
  assert.equal(row?.sync_state, 'idle');
  for (const key of [
    'sync_after',
    'sync_since',
    'sync_limit',
    'sync_resume',
    'sync_newest',
    'sync_failed_since',
    'sync_gap_from',
  ])
    assert.equal(row?.[key], null);
  assert.equal(row?.sync_origin_state, 'none');
  assert.equal(
    r.db.get<{ n: number }>('SELECT count(*) AS n FROM message_sighting WHERE reply_to_native_id IS NOT NULL')?.n,
    0,
  );
};
const safeRemoval = (e: unknown) =>
  e instanceof AppError && e.code === 'invalid' && e.message === 'Account removed; remote logout failed';

for (const elapsed of [0, 49999, 50000, 50001, 59999, 60000, 60001])
  for (const rejects of [false, true])
    for (const race of [false, true])
      test(`H1-F1 public disconnect ${race ? 'post-grace race' : 'microtask ready'} ${rejects ? 'reject' : 'fulfill'} at ${elapsed}ms respects strict entry50s`, async (t) => {
        const release = deferred();
        const timer = deferred<number>();
        const timeout = deferred();
        const r = await durabilityRig({
          names: ['alice'],
          decorate(c) {
            return {
              ...c,
              async *fetchHistory() {
                yield { messages: [message(3, { replyToNativeId: 'unresolved' })], resume: null };
              },
              async logout() {
                if (race) await release.promise;
                else await Promise.resolve();
                r.advance(elapsed);
                if (rejects) throw new Error('RAW_LOGOUT_SECRET');
                await c.logout();
              },
            };
          },
          sleep: (ms) => {
            timer.resolve(ms);
            return timeout.promise;
          },
        });
        t.after(async () => {
          release.resolve();
          timeout.resolve();
          await r.close();
        });
        r.include();
        await r.host.settle();
        const at = r.now().getTime();
        const removal = r.host.disconnect(r.ctx(), r.accounts.get('alice') ?? 0);
        // Observe immediately, before ANY await of the removal operation.
        removed(r);
        const result =
          elapsed < 50000 && !rejects ? assert.doesNotReject(removal) : assert.rejects(removal, safeRemoval);
        if (race) {
          assert.equal(await timer.promise, 50000);
          release.resolve();
        }
        await result;
        assert.equal(r.now().getTime() - at, elapsed);
        removed(r);
        assert.doesNotMatch(JSON.stringify(r.db.all('SELECT * FROM action_log')), /RAW_LOGOUT_SECRET|unresolved/);
      });

for (const preparation of ['local-transaction', 'cold-restoration'] as const)
  test(`H1-F1 public disconnect charges ${preparation} to original method-entry budget`, async (t) => {
    let cold = false;
    let logoutCalls = 0;
    let stale: ConnectorContext | undefined;
    const r = await durabilityRig({
      names: ['alice'],
      decorate(c, ctx) {
        if (cold) r.advance(40000);
        stale = ctx;
        return {
          ...c,
          async logout() {
            logoutCalls++;
            await Promise.resolve();
            r.advance(10000);
            await c.logout();
          },
        };
      },
    });
    t.after(() => r.close());
    r.include();
    await r.host.settle();
    let host = r.host;
    if (preparation === 'cold-restoration') {
      await host.stopAll();
      cold = true;
      host = r.build();
    }
    const run = r.db.run.bind(r.db);
    if (preparation === 'local-transaction')
      r.db.run = (sql, ...params) => {
        const result = run(sql, ...params);
        if (sql.startsWith("UPDATE channel_account SET state='removed'")) r.advance(40000);
        return result;
      };
    const at = r.now().getTime();
    const removal = host.disconnect(r.ctx(), r.accounts.get('alice') ?? 0);
    removed(r);
    await assert.rejects(removal, safeRemoval);
    assert.equal(r.now().getTime() - at, 50000);
    assert.equal(logoutCalls, 1);
    assert.ok(stale);
    const oldContext = stale;
    assert.throws(() => oldContext.saveSession(null), /no longer active/);
    r.db.run = run;
    await host.stopAll();
  });

for (const rejects of [false, true])
  test(`H1-F1 genuine hung logout deadline then late ${rejects ? 'reject' : 'resolve'} cannot clear successor session or emit connected`, async (t) => {
    const release = deferred();
    const entered = deferred<number>();
    const timeout = deferred();
    let first = true;
    let stale: ConnectorContext | undefined;
    const effects: string[] = [];
    const r = await durabilityRig({
      names: ['alice'],
      decorate(c, ctx) {
        if (!first) return c;
        first = false;
        stale = ctx;
        return {
          ...c,
          async logout() {
            await release.promise;
            for (const value of ['STALE_NONNULL', null]) {
              assert.throws(() => ctx.saveSession(value), /no longer active/);
              effects.push('fenced');
            }
            if (rejects) throw new Error('LATE_RAW_SECRET');
          },
        };
      },
      sleep: (ms) => {
        entered.resolve(ms);
        return timeout.promise;
      },
    });
    t.after(async () => {
      release.resolve();
      timeout.resolve();
      await r.close();
    });
    r.include();
    await r.host.settle();
    const oldSink = r.sinks.get(r.accounts.get('alice') ?? 0);
    const at = r.now().getTime();
    const removal = r.host.disconnect(r.ctx(), r.accounts.get('alice') ?? 0);
    removed(r);
    const rejection = assert.rejects(removal, safeRemoval);
    assert.equal(await entered.promise, 50000);
    r.advance(50000);
    timeout.resolve();
    await rejection;
    assert.equal(r.now().getTime() - at, 50000);
    await connect(r.host, r.ctx());
    const before = r.db.get<{ session_sealed: Uint8Array }>(
      'SELECT session_sealed FROM channel_account',
    )?.session_sealed;
    assert.ok(before && stale);
    release.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await oldSink?.emit({ type: 'status', state: 'connected' });
    assert.equal(r.db.get<{ state: string }>('SELECT state FROM channel_account')?.state, 'connected');
    const after = r.db.get<{ session_sealed: Uint8Array }>(
      'SELECT session_sealed FROM channel_account',
    )?.session_sealed;
    assert.ok(after);
    assert.equal(open(Buffer.alloc(32, 7), after), open(Buffer.alloc(32, 7), before));
    assert.deepEqual(effects, ['fenced', 'fenced']);
    const oldContext = stale;
    assert.throws(() => oldContext.saveSession(null), /no longer active/);
  });

for (const elapsed of [4999, 5000, 5001])
  test(`H1-F1 public stopAll ready completion at ${elapsed}ms keeps existing strict5s cleanup budget`, async (t) => {
    let checking = true;
    const r = await durabilityRig({
      names: ['alice'],
      decorate(c) {
        return {
          ...c,
          async stop() {
            await Promise.resolve();
            if (checking) r.advance(elapsed);
            await c.stop();
          },
        };
      },
    });
    t.after(async () => {
      checking = false;
      await r.host.startAll();
      await r.close();
    });
    const stopped = r.host.stopAll();
    if (elapsed < 5000) await assert.doesNotReject(stopped);
    else await assert.rejects(stopped, /Account stop failed/);
    checking = false;
  });

for (const rejects of [false, true])
  test(`H1-F1 hung stop late ${rejects ? 'reject' : 'resolve'} is retired before fresh start; old nonnull/null callbacks cannot corrupt successor`, async (t) => {
    const entered = deferred<number>();
    const timeout = deferred();
    const late = deferred();
    let first = true;
    let oldContext: ConnectorContext | undefined;
    let fenced = 0;
    const r = await durabilityRig({
      names: ['alice'],
      decorate(c, ctx) {
        if (!first) return c;
        first = false;
        oldContext = ctx;
        return {
          ...c,
          async stop() {
            await late.promise;
            for (const value of ['LATE_STOP_SECRET', null]) {
              assert.throws(() => ctx.saveSession(value), /no longer active/);
              fenced++;
            }
            if (rejects) throw new Error('LATE_STOP_ERROR_SECRET');
          },
        };
      },
      sleep: (ms) => {
        entered.resolve(ms);
        return timeout.promise;
      },
    });
    t.after(async () => {
      late.resolve();
      timeout.resolve();
      await r.close();
    });
    const stop = r.host.stopAll();
    const rejection = assert.rejects(stop, /Account stop failed/);
    assert.equal(await entered.promise, 5000);
    r.advance(5000);
    timeout.resolve();
    await rejection;
    await r.host.startAll();
    const before = r.db.get<{ session_sealed: Uint8Array }>(
      'SELECT session_sealed FROM channel_account',
    )?.session_sealed;
    assert.ok(before && oldContext);
    const stale = oldContext;
    late.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fenced, 2);
    assert.throws(() => stale.saveSession(null), /no longer active/);
    assert.deepEqual(
      r.db.get<{ session_sealed: Uint8Array }>('SELECT session_sealed FROM channel_account')?.session_sealed,
      before,
    );
    assert.equal(r.db.get<{ state: string }>('SELECT state FROM channel_account')?.state, 'connected');
  });
