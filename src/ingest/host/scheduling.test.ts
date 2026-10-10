import assert from 'node:assert/strict';
import test from 'node:test';
import type { FixtureLine, HistoryRequest } from '../../contracts/index.ts';
import { history } from '../../log/index.ts';
import { getMessages } from '../index.ts';
import { connect, controlled, deferred, delivery, message, setup } from './test-support.ts';

test('R6.4 failed fetch backoff doubles 1 minute to 1 hour and abandons after 24 hours', async (t) => {
  const waits: number[] = [];
  const requests: HistoryRequest[] = [];
  const lines: FixtureLine[] = [
    ...setup(),
    { t: 'history_error', account: 'alice', chatKey: 'selected', afterPages: 0 },
    { t: 'mark', name: 'failure' },
  ];
  const r = await controlled(lines, {
    decorate(c) {
      return {
        ...c,
        async *fetchHistory(req) {
          requests.push({ ...req });
          yield* c.fetchHistory(req);
        },
      };
    },
    async sleep(ms, h) {
      waits.push(ms);
      h.clock.advance(ms);
    },
  });
  t.after(async () => {
    await r.host.stopAll();
    r.h.close();
  });
  await r.control.advanceTo('failure');
  const id = await connect(r.host, r.ctx());
  await r.host.startAll();
  r.host.includeChat(r.ctx(), id, 'selected', { agreedWordingVersion: 1, company: null });
  await r.host.settle();
  assert.deepEqual(waits.slice(0, 7), [60000, 120000, 240000, 480000, 960000, 1920000, 3600000]);
  assert.ok(waits.every((ms) => ms <= 3600000));
  assert.ok(requests.length > 7 && requests.length < 40);
  assert.ok(requests.every((req) => JSON.stringify(req) === JSON.stringify(requests[0])));
  assert.equal(r.host.listAccounts(r.ctx())[0]?.gaps[0]?.abandoned, true);
  assert.equal(r.h.db.get<{ sync_state: string }>('SELECT * FROM account_chat')?.sync_state, 'idle');
  assert.equal(history(r.ctx(), { action: 'chat.gap_abandon' }).length, 1);
});

test('E4 inclusion commits syncing before queued waits; one account never overlaps listing/history; concurrent live newest survives', async (t) => {
  const entered = deferred();
  const release = deferred();
  const requests: string[] = [];
  let active = 0;
  const lines = setup(['first', 'second']).concat(delivery('alice', 'second', message(10)));
  const r = await controlled(lines, {
    decorate(c) {
      return {
        ...c,
        async listChats() {
          assert.equal(active, 0);
          return c.listChats();
        },
        async *fetchHistory(req) {
          assert.equal(active++, 0);
          requests.push(req.chat.key);
          try {
            if (req.chat.key === 'first') {
              entered.resolve();
              await release.promise;
            }
            yield { messages: req.chat.key === 'second' ? [message(5)] : [], resume: null };
          } finally {
            active--;
          }
        },
      };
    },
  });
  t.after(async () => {
    release.resolve();
    await r.host.stopAll();
    r.h.close();
  });
  await r.control.advanceTo('setup');
  const id = await connect(r.host, r.ctx());
  await r.host.startAll();
  for (const key of ['first', 'second'])
    r.host.includeChat(r.ctx(), id, key, { agreedWordingVersion: 1, company: null });
  assert.deepEqual(
    r.h.db.all<{ sync_state: string }>('SELECT sync_state FROM account_chat').map((a) => a.sync_state),
    ['syncing', 'syncing'],
  );
  await entered.promise;
  await r.control.advanceTo('end');
  assert.deepEqual(requests, ['first']);
  const listing = r.host.listChats(r.ctx(), id);
  release.resolve();
  await listing;
  await r.host.settle();
  assert.deepEqual(requests, ['first', 'second']);
  assert.equal(
    r.h.db.get<{ live_cursor: string }>(
      "SELECT ac.live_cursor FROM account_chat ac JOIN chat ch ON ch.id=ac.chat_id WHERE ch.chat_key='second'",
    )?.live_cursor,
    message(10).cursor,
  );
});

test('complete empty fetch records service metadata cursor once; interrupted empty fetch never replaces kept after', async (t) => {
  let calls = 0;
  let cursor = 'service-1';
  const retry = deferred();
  const failed = deferred();
  let fail = false;
  const requests: HistoryRequest[] = [];
  const r = await controlled(setup(), {
    decorate(c) {
      return {
        ...c,
        async listChats() {
          return (await c.listChats()).map((e) => ({ ...e, latestCursor: cursor }));
        },
        async *fetchHistory(req) {
          requests.push({ ...req });
          calls++;
          yield { messages: [], resume: null };
          if (fail) {
            failed.resolve();
            throw new Error('synthetic interrupted service page');
          }
        },
      };
    },
    async sleep(ms, h) {
      if (ms >= 60000) await retry.promise;
      else h.clock.advance(ms);
    },
  });
  t.after(async () => {
    fail = false;
    retry.resolve();
    await r.host.stopAll();
    r.h.close();
  });
  await r.control.advanceTo('setup');
  const id = await connect(r.host, r.ctx());
  await r.host.startAll();
  r.host.includeChat(r.ctx(), id, 'selected', { agreedWordingVersion: 1, company: null });
  await r.host.settle();
  assert.equal(r.h.db.get<{ live_cursor: string }>('SELECT live_cursor FROM account_chat')?.live_cursor, cursor);
  await r.host.stopAll();
  await r.host.startAll();
  await r.host.settle();
  assert.equal(calls, 1);
  cursor = 'service-2';
  fail = true;
  await r.host.stopAll();
  await r.host.startAll();
  await failed.promise;
  const row = r.h.db.get<{ live_cursor: string; sync_after: string; sync_state: string }>('SELECT * FROM account_chat');
  assert.equal(row?.live_cursor, 'service-1');
  assert.equal(row?.sync_after, 'service-1');
  assert.equal(row?.sync_state, 'failed');
  assert.equal(requests.at(-1)?.after, 'service-1');
  fail = false;
  retry.resolve();
  await r.host.settle();
  assert.equal(r.h.db.get<{ live_cursor: string }>('SELECT live_cursor FROM account_chat')?.live_cursor, 'service-2');
});

test('H1 decoded edit/delete events leave stored R10 state unchanged at exact later boundary', async (t) => {
  const original = message(1);
  const lines: FixtureLine[] = [
    ...setup(),
    delivery('alice', 'selected', original),
    { t: 'mark', name: 'original' },
    {
      t: 'edit',
      account: 'alice',
      chatKey: 'selected',
      message: { ...original, text: 'later edit', editedAt: message(2).sentAt },
    },
    { t: 'delete', account: 'alice', nativeIds: [original.nativeId], deletedAt: message(3).sentAt },
  ];
  const r = await controlled(lines);
  t.after(async () => {
    await r.host.stopAll();
    r.h.close();
  });
  await r.control.advanceTo('setup');
  const id = await connect(r.host, r.ctx());
  await r.host.startAll();
  r.host.includeChat(r.ctx(), id, 'selected', { agreedWordingVersion: 1, company: null });
  await r.host.settle();
  await r.control.advanceTo('original');
  await r.control.advanceTo('end');
  const m = getMessages(r.ctx(), {})[0];
  assert.equal(m?.text, original.text);
  assert.equal(m?.edited, false);
  assert.equal(m?.deleted, false);
  assert.equal(r.h.db.get<{ n: number }>('SELECT count(*) AS n FROM message_version')?.n, 0);
});
