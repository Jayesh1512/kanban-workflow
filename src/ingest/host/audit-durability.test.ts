import assert from 'node:assert/strict';
import test from 'node:test';
import type { Id } from '../../contracts/index.ts';
import { history, redact } from '../../log/index.ts';
import { getMessages } from '../index.ts';
import { durabilityRig } from './durability-support.ts';
import { chat, deferred, message } from './test-support.ts';

const names = [
  'message.reply_pending',
  'message.reply_link',
  'chat.sync_queue',
  'chat.sync_start',
  'chat.sync_page',
  'chat.sync_failure',
  'chat.sync_complete',
];
const keys: Record<string, string[]> = {
  'message.reply_pending': ['accountId', 'recordedAt'],
  'message.reply_link': ['accountId', 'replyToId', 'linkedAt'],
  'chat.sync_queue': ['accountId', 'queuedAt'],
  'chat.sync_start': ['accountId', 'fromTime', 'startedAt'],
  'chat.sync_page': ['accountId', 'committedAt'],
  'chat.sync_failure': ['accountId', 'failedAt'],
  'chat.sync_complete': ['accountId', 'completedAt'],
};
const snapshot = (r: Awaited<ReturnType<typeof durabilityRig>>) =>
  [
    'message',
    'message_sighting',
    'account_chat',
    'chat_gap',
    'identity',
    'contact',
    'chat_participant',
    'action_log',
  ].map((table) => r.db.all(`SELECT * FROM ${table} ORDER BY rowid`));

test('actual seven-action runtime audit: duplicate-only pages/repeated failure/no-gap completion, exact actors/payloads/citations/redaction/count0', async (t) => {
  let attempt = 0;
  const r = await durabilityRig({
    decorate(c) {
      return {
        ...c,
        async *fetchHistory() {
          attempt++;
          if (attempt < 3) {
            yield { messages: [message(3, { replyToNativeId: 'native-2' })], resume: 'opaque-resume' };
            throw new Error('RAW_NATIVE_SESSION_CONTENT_ERROR');
          }
          yield { messages: [message(2)], resume: null };
          yield { messages: [message(2)], resume: null };
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
  const logs = history(r.ctx(), { limit: 1000 }).filter((e) => names.includes(e.action));
  assert.deepEqual([...new Set(logs.map((e) => e.action))].sort(), names.toSorted());
  assert.equal(logs.filter((e) => e.action === 'chat.sync_failure').length, 2);
  assert.equal(logs.filter((e) => e.action === 'chat.sync_page').length, 4);
  assert.equal(logs.filter((e) => e.action === 'chat.sync_start').length, 1);
  assert.equal(logs.filter((e) => e.action === 'message.reply_pending').length, 1);
  for (const e of logs) {
    assert.deepEqual(Object.keys(e.after as object).sort(), keys[e.action]?.toSorted());
    assert.equal(e.actor.kind, e.action === 'chat.sync_queue' ? 'teammate' : 'system');
    if (e.action === 'chat.sync_queue') assert.equal(e.actor.name, 'alice');
    assert.equal(e.before === null, e.action !== 'message.reply_link');
    if (e.action === 'message.reply_link') assert.deepEqual(e.before, { replyToId: null });
    for (const [key, value] of Object.entries(e.after as Record<string, unknown>))
      if (key.endsWith('At') || key === 'fromTime') assert.match(String(value), /^\d{4}-\d{2}-\d{2}T.*\.\d{3}Z$/);
    assert.equal(e.reason, '');
  }
  const source = getMessages(r.ctx(), {}).find((m) => m.sentAt === message(3).sentAt);
  const target = getMessages(r.ctx(), {}).find((m) => m.sentAt === message(2).sentAt);
  assert.ok(source && target);
  assert.deepEqual(logs.find((e) => e.action === 'message.reply_pending')?.messageIds, [source.id]);
  const link = logs.find((e) => e.action === 'message.reply_link');
  assert.ok(link);
  assert.deepEqual(link.messageIds, [source.id, target.id]);
  assert.deepEqual(logs.filter((e) => e.action === 'chat.sync_page')[0]?.messageIds, [target.id]); // Final duplicate-only page cites its retained fact.
  assert.equal(
    r.db.get<{ n: number }>(
      "SELECT count(*) AS n FROM action_log WHERE action LIKE 'card.%' OR action IN ('message.attach','message.detach')",
    )?.n,
    0,
  );
  assert.equal(r.db.get<{ n: number }>('SELECT count(*) AS n FROM decision')?.n, 0);
  assert.doesNotMatch(JSON.stringify(logs), /RAW_NATIVE|native-|opaque-resume|content [23]|session/);
  const select = (id: Id) => ({
    messageIds: [id],
    decisionIds: [],
    cardIds: [],
    reviewItemIds: [],
    contactIds: [],
    companyIds: [],
  });
  const before = snapshot(r);
  assert.throws(
    () =>
      r.db.tx(() => {
        redact(r.system, select(target.id));
        assert.equal(history(r.ctx(), { action: 'message.reply_link' })[0]?.redacted, true);
        throw new Error('outer rollback');
      }),
    /outer rollback/,
  );
  assert.deepEqual(snapshot(r), before);
  for (const id of [source.id, target.id]) {
    assert.throws(
      () =>
        r.db.tx(() => {
          const original = r.db.get<Record<string, unknown>>('SELECT * FROM action_log WHERE id=?', link.id);
          redact(r.system, select(id));
          const after = history(r.ctx(), { action: 'message.reply_link' })[0];
          assert.equal(after?.redacted, true);
          assert.equal(after?.after, null);
          assert.equal(after?.action, 'message.reply_link');
          assert.equal(after?.subjectId, source.id);
          assert.equal(after?.actor.kind, 'system');
          assert.equal(after?.at, original?.at);
          throw new Error('selector rollback');
        }),
      /selector rollback/,
    );
  }
  redact(r.system, select(target.id));
  assert.equal(history(r.ctx(), { action: 'message.reply_link' })[0]?.redacted, true);
});

for (const action of names)
  test(`actual ${action} log failure rolls back its owning message/page/queue/origin/gap/completion transaction`, async (t) => {
    const retry = deferred();
    let fetches = 0;
    const r = await durabilityRig({
      decorate(c) {
        return {
          ...c,
          async *fetchHistory() {
            fetches++;
            if (action === 'chat.sync_failure') throw new Error('synthetic failure');
            yield { messages: [message(3, { replyToNativeId: 'native-2' })], resume: 'opaque-page' };
          },
        };
      },
      sleep: async () => retry.promise,
    });
    t.after(async () => {
      retry.resolve();
      await r.close();
    });
    const fault = () =>
      r.db.run(
        `CREATE TEMP TRIGGER reject_owned_audit BEFORE INSERT ON action_log WHEN NEW.action='${action}' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END`,
      );
    if (action.startsWith('message.')) {
      r.include();
      await r.host.settle();
      if (action === 'message.reply_link') {
        // Source is pending from the committed initial history page.
        assert.equal(getMessages(r.ctx(), {})[0]?.replyToId, null);
      }
      const before = snapshot(r);
      fault();
      const m = action === 'message.reply_pending' ? message(7, { replyToNativeId: 'never' }) : message(2);
      await assert.rejects(
        r.sinks.get(r.accounts.get('alice') ?? 0)?.emit({ type: 'message', chat: chat('selected'), message: m }) ??
          Promise.reject(new Error('no sink')),
        /synthetic audit failure/,
      );
      assert.deepEqual(snapshot(r), before);
    } else {
      fault();
      const before = snapshot(r);
      if (action === 'chat.sync_queue') {
        assert.throws(() => r.include(), /synthetic audit failure/);
        assert.deepEqual(snapshot(r), before);
        assert.equal(fetches, 0);
      } else {
        r.include();
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (action === 'chat.sync_start' || action === 'chat.sync_failure')
          await assert.rejects(r.host.settle(), /Host background work failed/);
        const row = r.db.get<Record<string, unknown>>('SELECT * FROM account_chat');
        assert.equal(row?.sync_origin_state, action === 'chat.sync_start' ? 'queued' : 'captured');
        assert.equal(row?.sync_after, null);
        assert.equal(row?.sync_limit, 200);
        assert.equal(history(r.ctx(), { action }).length, 0);
        if (action === 'chat.sync_start') {
          assert.equal(fetches, 0);
          assert.equal(row?.sync_gap_from, null);
        }
        if (action === 'chat.sync_page') {
          assert.equal(getMessages(r.ctx(), {}).length, 0);
          assert.equal(row?.sync_resume, null);
          assert.equal(r.db.get<{ n: number }>('SELECT count(*) AS n FROM message_sighting')?.n, 0);
          assert.equal(r.db.get<{ n: number }>('SELECT count(*) AS n FROM contact')?.n, 0);
        }
        if (action === 'chat.sync_failure') {
          assert.equal(row?.sync_state, 'syncing');
          assert.equal(row?.sync_failed_since, null);
          assert.equal(r.db.get<{ n: number }>('SELECT count(*) AS n FROM chat_gap')?.n, 0);
        }
        if (action === 'chat.sync_complete') {
          assert.equal(row?.sync_resume, 'opaque-page');
          assert.equal(row?.sync_newest, message(3).cursor);
          assert.equal(getMessages(r.ctx(), {}).length, 1);
          assert.equal(row?.sync_state, 'failed');
        }
      }
    }
    r.db.run('DROP TRIGGER reject_owned_audit');
    await r.host.stopAll();
  });
