import assert from 'node:assert/strict';
import test from 'node:test';
import type { HistoryPage, HistoryRequest } from '../../contracts/index.ts';
import { history } from '../../log/index.ts';
import { getMessages } from '../index.ts';
import { type DurabilityRig, durabilityRig } from './durability-support.ts';
import { chat, deferred, message } from './test-support.ts';

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const row = (r: DurabilityRig) => r.db.get<Record<string, unknown>>('SELECT * FROM account_chat');
const gap = (r: DurabilityRig) => r.db.get<Record<string, unknown>>('SELECT * FROM chat_gap ORDER BY id DESC LIMIT 1');
function constructionFailure(kind: 'fetch' | 'getter' | 'factory'): AsyncIterable<HistoryPage> {
  if (kind === 'fetch') throw new Error('RAW_CONSTRUCTION_SECRET');
  if (kind === 'getter')
    return {
      get [Symbol.asyncIterator](): () => AsyncIterator<HistoryPage> {
        throw new Error('RAW_GETTER_SECRET');
      },
    };
  return {
    [Symbol.asyncIterator]() {
      throw new Error('RAW_FACTORY_SECRET');
    },
  };
}

for (const kind of ['fetch', 'getter', 'factory'] as const)
  test(`H1-F2 actual ${kind} synchronous failure atomically fails exact request then one controlled retry recovers/closes`, async (t) => {
    const retry = deferred();
    const requests: HistoryRequest[] = [];
    const delays: number[] = [];
    let microtask = false;
    let dispatchedWithoutAwait = false;
    const r = await durabilityRig({
      names: ['alice'],
      decorate(c) {
        return {
          ...c,
          fetchHistory(req) {
            requests.push({ ...req });
            dispatchedWithoutAwait ||= !microtask && row(r)?.sync_origin_state === 'captured';
            if (requests.length === 1) return constructionFailure(kind);
            return c.fetchHistory(req);
          },
        };
      },
      sleep: async (ms) => {
        delays.push(ms);
        await retry.promise;
        r.advance(ms);
      },
    });
    t.after(async () => {
      retry.resolve();
      await r.close();
    });
    const run = r.db.run.bind(r.db);
    r.db.run = (sql, ...params) => {
      const result = run(sql, ...params);
      if (sql.includes("sync_origin_state='captured'"))
        queueMicrotask(() => {
          microtask = true;
        });
      return result;
    };
    r.include();
    await turn();
    const original = row(r);
    assert.equal(original?.sync_state, 'failed');
    assert.equal(original?.sync_origin_state, 'captured');
    assert.equal(original?.sync_failed_since, r.now().toISOString());
    assert.equal(original?.sync_gap_from, original?.sync_since);
    assert.equal(original?.sync_after, null);
    assert.equal(original?.sync_limit, 200);
    assert.equal(original?.sync_resume, null);
    assert.deepEqual(delays, [60000]);
    assert.equal(requests.length, 1);
    assert.equal(dispatchedWithoutAwait, true);
    const opened = gap(r);
    assert.equal(opened?.from_time, original?.sync_gap_from);
    assert.equal(opened?.bound_provenance, 'exact');
    assert.equal(history(r.ctx(), { action: 'chat.sync_failure' }).length, 1);
    assert.equal(history(r.ctx(), { action: 'chat.sync_start' }).length, 1);
    assert.equal(history(r.ctx(), { action: 'chat.sync_queue' }).length, 1);
    // An advanced live cursor never changes the request or its bound.
    await r.sinks
      .get(r.accounts.get('alice') ?? 0)
      ?.emit({ type: 'message', chat: chat('selected'), message: message(20) });
    assert.equal(row(r)?.sync_gap_from, original?.sync_gap_from);
    retry.resolve();
    await r.host.settle();
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], requests[0]);
    assert.equal(row(r)?.sync_state, 'idle');
    assert.equal(row(r)?.sync_origin_state, 'none');
    assert.equal(row(r)?.sync_gap_from, null);
    assert.equal(row(r)?.live_cursor, message(20).cursor);
    assert.equal(gap(r)?.id, opened?.id);
    assert.equal(gap(r)?.from_time, opened?.from_time);
    assert.ok(gap(r)?.closed_at);
    assert.equal(history(r.ctx(), { action: 'chat.sync_complete' }).length, 1);
    assert.equal(getMessages(r.ctx(), {}).length, 1);
    assert.doesNotMatch(JSON.stringify(r.db.all('SELECT * FROM action_log')), /RAW_.*SECRET/);
    r.db.run = run;
  });

for (const kind of ['fetch', 'getter', 'factory'] as const)
  test(`H1-F2 repeated ${kind} failures log EVERY attempt, double1min to1h, abandon exactly24h with immutable exact gap/hold`, async (t) => {
    let attempts = 0;
    const delays: number[] = [];
    const bounds: unknown[] = [];
    const originals: HistoryRequest[] = [];
    const r = await durabilityRig({
      names: ['alice'],
      decorate(c) {
        return {
          ...c,
          fetchHistory(req) {
            attempts++;
            bounds.push(row(r)?.sync_gap_from);
            originals.push(req);
            return constructionFailure(kind);
          },
        };
      },
      sleep: async (ms) => {
        delays.push(ms);
        assert.equal(row(r)?.sync_state, 'failed');
        assert.equal(row(r)?.sync_origin_state, 'captured');
        assert.equal(gap(r)?.closed_at, null);
        assert.equal(gap(r)?.abandoned_at, null);
        r.advance(ms);
      },
    });
    t.after(() => r.close());
    r.include();
    const start = r.now().getTime();
    await r.host.settle();
    assert.ok(attempts > 7);
    assert.deepEqual(delays.slice(0, 7), [60000, 120000, 240000, 480000, 960000, 1920000, 3600000]);
    assert.equal(
      delays.reduce((a, b) => a + b, 0),
      86400000,
    );
    assert.equal(r.now().getTime() - start, 86400000);
    assert.ok(delays.every((ms) => ms <= 3600000));
    assert.equal(new Set(bounds).size, 1);
    for (const request of originals) assert.deepEqual(request, originals[0]);
    assert.equal(history(r.ctx(), { action: 'chat.sync_failure', limit: 1000 }).length, attempts);
    assert.equal(history(r.ctx(), { action: 'chat.sync_start' }).length, 1);
    assert.equal(history(r.ctx(), { action: 'chat.gap_open' }).length, 1);
    assert.equal(history(r.ctx(), { action: 'chat.gap_abandon' }).length, 1);
    assert.equal(gap(r)?.from_time, bounds[0]);
    assert.equal(gap(r)?.bound_provenance, 'exact');
    assert.equal(gap(r)?.abandoned_at, r.now().toISOString());
    assert.equal(row(r)?.sync_state, 'idle');
    assert.equal(row(r)?.sync_failed_since, null);
    assert.equal(row(r)?.sync_origin_state, 'none');
    assert.equal(r.host.listAccounts(r.ctx())[0]?.gaps[0]?.abandoned, true);
  });

for (const fault of ['store', 'audit'] as const)
  test(`H1-F2 ${fault} failure rolls back failed/firstfailure/gap/log as one transaction and preserves scheduling eligibility`, async (t) => {
    let attempts = 0;
    const r = await durabilityRig({
      names: ['alice'],
      decorate(c) {
        return {
          ...c,
          fetchHistory(req) {
            if (++attempts === 1) return constructionFailure('fetch');
            return c.fetchHistory(req);
          },
        };
      },
    });
    t.after(() => r.close());
    r.db.run(
      fault === 'store'
        ? "CREATE TEMP TRIGGER reject_failure BEFORE UPDATE OF sync_state ON account_chat WHEN NEW.sync_state='failed' BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END"
        : "CREATE TEMP TRIGGER reject_failure BEFORE INSERT ON action_log WHEN NEW.action='chat.sync_failure' BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END",
    );
    r.include();
    await assert.rejects(r.host.settle(), /Host background work failed/);
    const original = row(r);
    assert.equal(original?.sync_state, 'syncing');
    assert.equal(original?.sync_origin_state, 'captured');
    assert.equal(original?.sync_failed_since, null);
    assert.equal(gap(r), undefined);
    assert.equal(history(r.ctx(), { action: 'chat.sync_failure' }).length, 0);
    r.db.run('DROP TRIGGER reject_failure');
    await r.host.stopAll();
    await r.host.startAll();
    await r.host.settle();
    assert.equal(attempts, 2);
    assert.equal(history(r.ctx(), { action: 'chat.sync_queue' }).length, 1);
    assert.equal(history(r.ctx(), { action: 'chat.sync_start' }).length, 1);
    assert.equal(gap(r)?.from_time, original?.sync_gap_from);
    assert.ok(gap(r)?.closed_at);
    assert.equal(row(r)?.sync_state, 'idle');
  });

for (const fault of ['getter', 'call', 'reject', 'late-reject'] as const)
  test(`H1-F2 obtained iterator return ${fault} is observed without masking primary failure/retry`, async (t) => {
    let calls = 0;
    let returns = 0;
    const retry = deferred();
    const late = deferred<IteratorResult<HistoryPage>>();
    const r = await durabilityRig({
      names: ['alice'],
      decorate(c) {
        return {
          ...c,
          fetchHistory(req) {
            if (++calls > 1) return c.fetchHistory(req);
            const iterator: AsyncIterator<HistoryPage> = {
              async next() {
                throw new Error('PRIMARY_SECRET');
              },
              get return() {
                returns++;
                if (fault === 'getter') throw new Error('CLEANUP_GETTER_SECRET');
                return () => {
                  if (fault === 'call') throw new Error('CLEANUP_CALL_SECRET');
                  if (fault === 'reject') return Promise.reject(new Error('CLEANUP_REJECT_SECRET'));
                  return late.promise;
                };
              },
            };
            return { [Symbol.asyncIterator]: () => iterator };
          },
        };
      },
      sleep: () => retry.promise,
    });
    t.after(async () => {
      late.resolve({ done: true, value: undefined });
      retry.resolve();
      await r.close();
    });
    r.include();
    await turn();
    assert.equal(row(r)?.sync_state, 'failed');
    assert.equal(history(r.ctx(), { action: 'chat.sync_failure' }).length, 1);
    assert.equal(returns, 1);
    retry.resolve();
    await assert.doesNotReject(r.host.settle());
    assert.equal(calls, 2);
    assert.ok(gap(r)?.closed_at);
    if (fault === 'late-reject') late.reject(new Error('LATE_RETURN_SECRET'));
    else late.resolve({ done: true, value: undefined });
    await turn();
    assert.equal(row(r)?.sync_state, 'idle');
    assert.doesNotMatch(
      JSON.stringify(r.db.all('SELECT * FROM action_log')),
      /PRIMARY_SECRET|CLEANUP_.*SECRET|LATE_RETURN_SECRET/,
    );
  });

test('H1-F2 synchronous constructor cancels/reincludes before throwing; old failure never mutates successor request/gap', async (t) => {
  const held = deferred();
  let calls = 0;
  const r = await durabilityRig({
    names: ['alice'],
    decorate(c) {
      return {
        ...c,
        fetchHistory() {
          if (++calls === 1) {
            r.host.excludeChat(r.ctx(), r.accounts.get('alice') ?? 0, 'selected');
            r.include();
            throw new Error('CANCELLED_OLD_SECRET');
          }
          return {
            async *[Symbol.asyncIterator]() {
              await held.promise;
              yield { messages: [message(4)], resume: null };
            },
          };
        },
      };
    },
  });
  t.after(async () => {
    held.resolve();
    await r.close();
  });
  r.include();
  await turn();
  assert.equal(calls, 2);
  assert.equal(row(r)?.sync_state, 'syncing');
  assert.equal(row(r)?.sync_failed_since, null);
  assert.equal(gap(r), undefined);
  assert.equal(history(r.ctx(), { action: 'chat.sync_failure' }).length, 0);
  assert.equal(history(r.ctx(), { action: 'chat.sync_queue' }).length, 2);
  held.resolve();
  await assert.doesNotReject(r.host.settle());
  assert.equal(getMessages(r.ctx(), {}).length, 1);
  assert.equal(row(r)?.sync_state, 'idle');
});

test('H1-F2 construction faults after a committed newest-first page retain opaque resume/newest/reply/request/firstfailure and exact gap until recovery', async (t) => {
  const requests: HistoryRequest[] = [];
  const states: Record<string, unknown>[] = [];
  let attempts = 0;
  let unobtainedCleanup = 0;
  const r = await durabilityRig({
    names: ['alice'],
    decorate(c) {
      return {
        ...c,
        fetchHistory(req) {
          requests.push({ ...req });
          const current = row(r);
          assert.ok(current);
          states.push({ ...current });
          const attempt = ++attempts;
          if (attempt === 1)
            return {
              async *[Symbol.asyncIterator]() {
                yield { messages: [message(3, { replyToNativeId: 'native-2' })], resume: 'opaque-below-source' };
                throw new Error('FIRST_NEXT_SECRET');
              },
            };
          if (attempt < 5) {
            const iterable = {
              get return() {
                unobtainedCleanup++;
                throw new Error('UNOBTAINED_CLEANUP_SECRET');
              },
              get [Symbol.asyncIterator](): () => AsyncIterator<HistoryPage> {
                if (attempt === 2) throw new Error('SECOND_GETTER_SECRET');
                return () => {
                  throw new Error('THIRD_FACTORY_SECRET');
                };
              },
            };
            if (attempt === 4) throw new Error('FOURTH_CONSTRUCTION_SECRET');
            return iterable;
          }
          return {
            async *[Symbol.asyncIterator]() {
              yield { messages: [message(2)], resume: null };
            },
          };
        },
      };
    },
    sleep: async (ms) => {
      // Intervening live advance is outside the no-await capture→dispatch segment.
      await r.sinks
        .get(r.accounts.get('alice') ?? 0)
        ?.emit({ type: 'message', chat: chat('selected'), message: message(20) });
      r.advance(ms);
    },
  });
  t.after(() => r.close());
  r.include();
  const firstFailure = r.now().toISOString();
  await r.host.settle();
  assert.equal(attempts, 5);
  assert.equal(unobtainedCleanup, 0);
  for (const [index, request] of requests.entries()) {
    assert.equal(request.after, null);
    assert.equal(request.since, states[0]?.sync_since);
    assert.equal(request.limit, 200);
    assert.equal(request.resume, index === 0 ? null : 'opaque-below-source');
  }
  for (const state of states.slice(1)) {
    assert.equal(state.sync_resume, 'opaque-below-source');
    assert.equal(state.sync_newest, message(3).cursor);
    assert.equal(state.sync_gap_from, states[0]?.sync_gap_from);
    assert.equal(state.sync_failed_since, firstFailure);
    assert.equal(state.live_cursor, message(20).cursor);
  }
  const messages = getMessages(r.ctx(), {});
  assert.equal(messages.length, 3);
  const source = messages.find((m) => m.sentAt === message(3).sentAt);
  const target = messages.find((m) => m.sentAt === message(2).sentAt);
  assert.ok(source && target);
  assert.equal(source.replyToId, target.id);
  assert.equal(history(r.ctx(), { action: 'chat.sync_failure' }).length, 4);
  assert.equal(history(r.ctx(), { action: 'chat.gap_open' }).length, 1);
  assert.equal(history(r.ctx(), { action: 'chat.sync_start' }).length, 1);
  assert.equal(history(r.ctx(), { action: 'chat.sync_queue' }).length, 1);
  assert.equal(gap(r)?.from_time, states[0]?.sync_gap_from);
  assert.equal(gap(r)?.bound_provenance, 'exact');
  assert.ok(gap(r)?.closed_at);
  assert.equal(row(r)?.sync_state, 'idle');
  assert.equal(row(r)?.live_cursor, message(20).cursor);
});
