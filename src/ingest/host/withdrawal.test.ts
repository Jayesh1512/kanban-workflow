import assert from 'node:assert/strict';
import test from 'node:test';
import { setSetting } from '../../auth/index.ts';
import type { FixtureLine } from '../../contracts/index.ts';
import { record } from '../../log/index.ts';
import { getMessages } from '../index.ts';
import { chat, connect, controlled, deferred, delivery, message, setup } from './test-support.ts';

test('R31 callback only: withdraw all accounts, retain message IDs/company/agreement history, blank title, cancel and drop late pages/events', async (t) => {
  const entered = deferred();
  const release = deferred();
  const exited = deferred();
  let exits = 0;
  let starts = 0;
  const lines: FixtureLine[] = setup(['shared'], ['alice', 'bob']).map((l) =>
    l.t === 'chat' ? { ...l, chat: chat('shared', 'group') } : l,
  );
  lines.push(
    delivery('alice', 'shared', message(1)),
    delivery('bob', 'shared', message(1, { nativeId: 'bob-1' })),
    { t: 'mark', name: 'before-withdrawal' },
    delivery('alice', 'shared', message(2)),
    delivery('bob', 'shared', message(2, { nativeId: 'bob-2' })),
  );
  const r = await controlled(lines, {
    decorate(c) {
      return {
        ...c,
        async *fetchHistory() {
          if (++starts === 2) entered.resolve();
          await release.promise;
          try {
            yield { messages: [message(99, { text: 'LATE_INFLIGHT_MARKER' })], resume: null };
          } finally {
            if (++exits === 2) exited.resolve();
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
  const alice = await connect(r.host, r.ctx());
  const bob = await connect(r.host, r.ctx('bob'), 'bob');
  await r.host.startAll();
  for (const [id, name] of [
    [alice, 'alice'],
    [bob, 'bob'],
  ] as const)
    r.host.includeChat(r.ctx(name), id, 'shared', {
      agreedWordingVersion: 1,
      company: 'Named company retained for graph',
    });
  await entered.promise;
  await r.control.advanceTo('before-withdrawal');
  const original = getMessages(r.ctx(), {});
  assert.equal(original.length, 1);
  assert.equal(original[0]?.teammateIds.length, 2);
  const ch = r.h.db.get<{ id: number; named_company_id: number }>('SELECT * FROM chat');
  assert.ok(ch);
  assert.deepEqual(
    r.host.markWithdrawn(r.ctx(), alice, ch.id),
    original.map((m) => m.id),
  );
  assert.equal(r.h.db.get<{ title: string; named_company_id: number }>('SELECT * FROM chat')?.title, '');
  assert.equal(r.h.db.get<{ named_company_id: number }>('SELECT * FROM chat')?.named_company_id, ch.named_company_id);
  assert.deepEqual(
    r.h.db.all<{ decision: string }>('SELECT decision FROM chat_selection').map((a) => a.decision),
    ['withdrawn', 'withdrawn'],
  );
  assert.equal(r.h.db.get<{ n: number }>('SELECT count(*) AS n FROM account_chat')?.n, 0);
  assert.equal(r.h.db.get<{ n: number }>('SELECT count(*) AS n FROM chat_gap')?.n, 0);
  assert.equal(r.h.db.get<{ n: number }>("SELECT count(*) AS n FROM chat_agreement WHERE kind='confirmed'")?.n, 2);
  assert.equal(r.h.db.get<{ n: number }>("SELECT count(*) AS n FROM chat_agreement WHERE kind='withdrawn'")?.n, 2);
  await r.host.settle(); // Canceled tasks finish while the actual underlying page is still pending.
  await r.control.advanceTo('end');
  release.resolve();
  await exited.promise;
  assert.equal(getMessages(r.ctx(), {}).length, 1); // markWithdrawn does not implement purge early.
  assert.doesNotMatch(JSON.stringify(r.h.db.all('SELECT * FROM message')), /LATE_INFLIGHT_MARKER/);
  const listing = await r.host.listChats(r.ctx('bob'), bob);
  assert.equal(listing[0]?.decision, 'withdrawn');
  assert.equal(listing[0]?.title, 'Title shared'); // connector metadata only; stored title stays blank.
  assert.equal(listing[0]?.withdrawnBy, 'alice');
  setSetting(r.ctx(), 'require_agreement', false);
  assert.throws(
    () => r.host.includeChat(r.ctx('bob'), bob, 'shared', { agreedWordingVersion: 999, company: null }),
    /agreement/,
  );
  assert.equal(r.h.db.get<{ n: number }>("SELECT count(*) AS n FROM action_log WHERE action='chat.withdraw'")?.n, 0); // D1 owns the single final log.
});

test('withdrawal callback joins outer transaction; actual final log error rolls back durable state and cancellation recovers kept work', async (t) => {
  const entered = deferred();
  const release = deferred();
  let starts = 0;
  const r = await controlled(setup(), {
    decorate(c) {
      return {
        ...c,
        async *fetchHistory() {
          if (++starts === 1) {
            entered.resolve();
            await release.promise;
          }
          yield { messages: [message(1)], resume: null };
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
  r.host.includeChat(r.ctx(), id, 'selected', { agreedWordingVersion: 1, company: 'Retained named' });
  await entered.promise;
  const chatId = r.h.db.get<{ id: number }>('SELECT id FROM chat')?.id;
  assert.ok(chatId);
  const before = ['chat', 'chat_selection', 'chat_agreement', 'account_chat'].map((table) =>
    r.h.db.all(`SELECT * FROM ${table}`),
  );
  const run = r.h.db.run.bind(r.h.db);
  r.h.db.run = (sql, ...params) => {
    if (sql.startsWith('INSERT INTO action_log') && params[3] === 'chat.withdraw')
      throw new Error('synthetic final log failure');
    return run(sql, ...params);
  };
  assert.throws(
    () =>
      r.h.db.tx(() => {
        r.host.markWithdrawn(r.ctx(), id, chatId);
        record(r.ctx(), { action: 'chat.withdraw', subjectKind: 'chat', subjectId: chatId });
      }),
    /synthetic final log failure/,
  );
  assert.deepEqual(
    ['chat', 'chat_selection', 'chat_agreement', 'account_chat'].map((table) => r.h.db.all(`SELECT * FROM ${table}`)),
    before,
  );
  r.h.db.run = run;
  release.resolve();
  await r.host.settle();
  assert.equal(getMessages(r.ctx(), {}).length, 1);
  assert.equal(r.h.db.get<{ sync_state: string }>('SELECT sync_state FROM account_chat')?.sync_state, 'idle');
  assert.equal(starts, 2); // The canceled old generation cannot commit; rolled-back durable work is restored.
});

test('exclusion cancels a running fetch and preserves existing content; late failure cannot fabricate idle or overwrite a new inclusion', async (t) => {
  const entered = deferred();
  const release = deferred();
  let starts = 0;
  const r = await controlled(setup(), {
    decorate(c) {
      return {
        ...c,
        async *fetchHistory() {
          if (++starts === 1) {
            entered.resolve();
            await release.promise;
            throw new Error('late inflight failure');
          }
          yield { messages: [message(2)], resume: null };
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
  r.host.includeChat(r.ctx(), id, 'selected', { agreedWordingVersion: 1, company: null });
  await entered.promise;
  r.host.excludeChat(r.ctx(), id, 'selected');
  r.host.includeChat(r.ctx(), id, 'selected', { agreedWordingVersion: 1, company: null });
  assert.equal(r.h.db.get<{ sync_state: string }>('SELECT sync_state FROM account_chat')?.sync_state, 'syncing');
  release.resolve();
  await r.host.settle();
  assert.equal(getMessages(r.ctx(), {})[0]?.text, message(2).text);
  assert.equal(getMessages(r.ctx(), {}).length, 1);
  assert.equal(r.h.db.get<{ n: number }>('SELECT count(*) AS n FROM chat_gap')?.n, 0);
});
