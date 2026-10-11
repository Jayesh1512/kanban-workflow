import assert from 'node:assert/strict';
import test from 'node:test';
import type { HistoryRequest, Id } from '../../contracts/index.ts';
import { history } from '../../log/index.ts';
import { durabilityRig } from './durability-support.ts';
import { chat, deferred, message } from './test-support.ts';

const row = (r: Awaited<ReturnType<typeof durabilityRig>>, key = 'selected') =>
  r.db.get<Record<string, unknown>>(
    'SELECT ac.* FROM account_chat ac JOIN chat ch ON ch.id=ac.chat_id WHERE ac.account_id=? AND ch.chat_key=?',
    r.accounts.get('alice') ?? 0,
    key,
  );

test('post-I/O capture includes intervening OTHER-account shared maximum and cites witness; queue holds before wait', async (t) => {
  const entered = deferred();
  const release = deferred();
  const pageHold = deferred();
  const dispatched = deferred();
  let alice: Id = 0;
  let original: Record<string, unknown> | undefined;
  const requests: HistoryRequest[] = [];
  const r = await durabilityRig({
    keys: ['blocker', 'selected'],
    decorate(c, ctx) {
      return {
        ...c,
        async *fetchHistory(req) {
          if (ctx.accountId !== alice) return;
          if (req.chat.key === 'blocker') {
            entered.resolve();
            await release.promise;
            return;
          }
          requests.push(req);
          original = row(r);
          dispatched.resolve();
          await pageHold.promise;
          yield { messages: [message(2)], resume: 'opaque-resume' };
        },
      };
    },
  });
  alice = r.accounts.get('alice') ?? 0;
  t.after(async () => {
    release.resolve();
    pageHold.resolve();
    await r.close();
  });
  r.include('bob');
  await r.host.settle();
  r.include('alice', 'blocker');
  await entered.promise;
  r.include();
  assert.equal(row(r)?.sync_origin_state, 'queued');
  assert.equal(row(r)?.sync_gap_from, null);
  assert.equal(row(r)?.sync_state, 'syncing');
  assert.equal(history(r.ctx(), { action: 'chat.sync_queue' })[0]?.actor.kind, 'teammate');
  await r.sinks
    .get(r.accounts.get('bob') ?? 0)
    ?.emit({ type: 'message', chat: chat('selected'), message: message(10) });
  release.resolve();
  await dispatched.promise;
  assert.equal(original?.sync_gap_from, message(10).sentAt);
  const witness = r.db.get<{ id: Id }>('SELECT id FROM message WHERE sent_at=?', message(10).sentAt)?.id;
  assert.ok(witness);
  const start = history(r.ctx(), { action: 'chat.sync_start' })[0];
  assert.deepEqual(start?.messageIds, [witness]);
  await r.sinks.get(alice)?.emit({ type: 'message', chat: chat('selected'), message: message(20) });
  assert.equal(row(r)?.sync_gap_from, message(10).sentAt);
  pageHold.resolve();
  await r.host.settle();
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.limit, 200);
  assert.equal(row(r)?.sync_origin_state, 'none');
  assert.equal(row(r)?.sync_gap_from, null);
  assert.equal(row(r)?.live_cursor, message(20).cursor);
});

test('capture-before-page/queued-unstarted/service-only restore: exact immutable gaps and request, no guessed queue gap', async (t) => {
  const entered = deferred();
  const release = deferred();
  let attempt = 0;
  const requests: HistoryRequest[] = [];
  const r = await durabilityRig({
    keys: ['selected', 'queued'],
    decorate(c) {
      return {
        ...c,
        async *fetchHistory(req) {
          requests.push({ ...req });
          attempt++;
          if (attempt === 1) {
            entered.resolve();
            await release.promise;
          } else yield { messages: [], resume: 'opaque-service-only' };
        },
      };
    },
  });
  t.after(async () => {
    release.resolve();
    await r.close();
  });
  r.include();
  await entered.promise;
  r.include('alice', 'queued');
  const original = row(r);
  assert.equal(original?.sync_origin_state, 'captured');
  assert.equal(original?.sync_gap_from, original?.sync_since); // Empty inclusion uses ORIGINAL since.
  assert.equal(row(r, 'queued')?.sync_origin_state, 'queued');
  await r.host.stopAll();
  assert.equal(r.db.get<{ n: number }>('SELECT count(*) AS n FROM chat_gap')?.n, 0);
  release.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const fresh = r.build();
  await fresh.startAll();
  await fresh.settle();
  const gaps = r.db.all<{ from_time: string; bound_provenance: string; closed_at: string }>('SELECT * FROM chat_gap');
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]?.from_time, original?.sync_gap_from);
  assert.equal(gaps[0]?.bound_provenance, 'exact');
  assert.ok(gaps[0]?.closed_at);
  assert.deepEqual(requests[1], requests[0]); // Queued second has its own initial arguments, never a fake restore gap.
  assert.equal(row(r)?.sync_origin_state, 'none');
  assert.equal(row(r, 'queued')?.sync_origin_state, 'none');
  await fresh.stopAll();
});

test('empty catch-up without since uses FIRST dispatch now; retry/24h keeps exact abandoned origin and explicit provenance', async (t) => {
  let fail = false;
  let cursor: string | null = null;
  let failures = 0;
  const r = await durabilityRig({
    decorate(c) {
      return {
        ...c,
        async listChats() {
          return (await c.listChats()).map((e) => ({ ...e, latestAt: message(100).sentAt, latestCursor: cursor }));
        },
        async *fetchHistory() {
          if (fail) {
            failures++;
            throw new Error('RAW_ERROR_SECRET');
          }
          yield { messages: [], resume: null };
        },
      };
    },
    sleep: async (ms) => {
      r.advance(ms);
    },
  });
  t.after(() => r.close());
  r.include();
  await r.host.settle();
  cursor = 'opaque-service';
  fail = true;
  r.advance(1234);
  const first = r.now().toISOString();
  await r.host.stopAll();
  await r.host.startAll();
  await r.host.settle();
  assert.ok(failures > 7);
  const gap = r.db.get<{ from_time: string; bound_provenance: string; abandoned_at: string }>('SELECT * FROM chat_gap');
  assert.equal(gap?.from_time, first);
  assert.equal(gap?.bound_provenance, 'exact');
  assert.ok(gap?.abandoned_at);
  assert.equal(row(r)?.sync_origin_state, 'none');
  const failuresLog = history(r.ctx(), { action: 'chat.sync_failure', limit: 100 });
  assert.equal(failuresLog.length, failures);
  assert.doesNotMatch(JSON.stringify(r.db.all('SELECT * FROM action_log')), /RAW_ERROR_SECRET|opaque-service/);
  assert.equal(r.host.listAccounts(r.ctx())[0]?.gaps[0]?.abandoned, true);
});

test('new inclusion never reuses/closes an earlier exact equal-bound gap; abandoned gaps also remain immutable', async (t) => {
  const retry = deferred();
  let fail = true;
  const r = await durabilityRig({
    decorate(c) {
      return {
        ...c,
        async *fetchHistory() {
          if (fail) throw new Error('synthetic');
          yield { messages: [], resume: null };
        },
      };
    },
    sleep: async () => retry.promise,
  });
  t.after(async () => {
    retry.resolve();
    await r.close();
  });
  r.include();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const original = r.db.get<Record<string, unknown>>('SELECT * FROM chat_gap');
  assert.ok(original);
  r.host.excludeChat(r.ctx(), r.accounts.get('alice') ?? 0, 'selected');
  r.include();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const gaps = r.db.all<Record<string, unknown>>('SELECT * FROM chat_gap ORDER BY id');
  assert.equal(gaps.length, 2);
  assert.equal(gaps[0]?.from_time, gaps[1]?.from_time);
  assert.deepEqual(gaps[0], original);
  fail = false;
  retry.resolve();
  await r.host.settle();
  assert.deepEqual(r.db.get('SELECT * FROM chat_gap WHERE id=?', original.id as number), original);
  assert.ok(r.db.get<{ closed_at: string }>('SELECT closed_at FROM chat_gap ORDER BY id DESC LIMIT 1')?.closed_at);
});
