import assert from 'node:assert/strict';
import test from 'node:test';
import type { Id } from '../../contracts/index.ts';
import { record } from '../../log/index.ts';
import { getMessages } from '../index.ts';
import { durabilityRig } from './durability-support.ts';
import { chat, deferred, message } from './test-support.ts';

const snap = (r: Awaited<ReturnType<typeof durabilityRig>>) =>
  ['channel_account', 'message', 'message_sighting', 'account_chat', 'chat_gap', 'action_log', 'identity'].map(
    (table) => r.db.all(`SELECT * FROM ${table} ORDER BY rowid`),
  );

test('reused authenticated self rejected BEFORE connected/done/history overwrite; rejected access logged out/null, matching rotation retains namespace', async (t) => {
  let mismatch = false,
    logouts = 0;
  const r = await durabilityRig({
    decorate(c, ctx) {
      return {
        ...c,
        async login(input) {
          const step = await c.login(input);
          return step.kind === 'done' && mismatch
            ? { ...step, self: { ...step.self, userKey: 'different-authenticated-self' } }
            : step;
        },
        async logout() {
          logouts++;
          await c.logout();
          assert.equal(
            r.db.get<{ session_sealed: null }>('SELECT session_sealed FROM channel_account WHERE id=?', ctx.accountId)
              ?.session_sealed,
            null,
          );
        },
      };
    },
  });
  t.after(() => r.close());
  r.include();
  await r.host.settle();
  const a = r.accounts.get('alice') ?? 0;
  await r.sinks
    .get(a)
    ?.emit({ type: 'message', chat: chat('selected'), message: message(3, { replyToNativeId: 'retained-target' }) });
  const historical = r.db.get<{ self_identity_id: Id }>(
    'SELECT self_identity_id FROM channel_account WHERE id=?',
    a,
  )?.self_identity_id;
  const facts = r.db.all<{ native_id: string }>('SELECT * FROM message_sighting');
  await r.host.disconnect(r.ctx(), a);
  mismatch = true;
  const next = await r.host.beginLogin(r.ctx(), 'fixture', { acknowledgedNoticeVersion: null });
  assert.equal(next.accountId, a);
  await assert.rejects(r.host.continueLogin(r.ctx(), a, { account: 'alice' }), /Account login failed/);
  const state = r.db.get<{ self_identity_id: Id; state: string; session_sealed: null }>(
    'SELECT * FROM channel_account WHERE id=?',
    a,
  );
  assert.equal(state?.self_identity_id, historical);
  assert.equal(state?.state, 'disconnected');
  assert.equal(state?.session_sealed, null);
  assert.equal(logouts, 2);
  assert.equal(r.db.get("SELECT id FROM identity WHERE user_key='different-authenticated-self'"), undefined);
  assert.equal(getMessages(r.ctx(), {}).length, 1);
  assert.equal(r.db.all<{ native_id: string }>('SELECT * FROM message_sighting')[0]?.native_id, facts[0]?.native_id);
  mismatch = false;
  await r.host.beginLogin(r.ctx(), 'fixture', { acknowledgedNoticeVersion: null });
  assert.equal((await r.host.continueLogin(r.ctx(), a, { account: 'alice' })).kind, 'done');
  assert.equal(
    r.db.get<{ self_identity_id: Id }>('SELECT self_identity_id FROM channel_account WHERE id=?', a)?.self_identity_id,
    historical,
  );
});

test('actual outer final-log rollback restores pending/origin/request/gap; canceled withdrawal schedules durable successor safely', async (t) => {
  const first = deferred(),
    release = deferred();
  let calls = 0;
  const r = await durabilityRig({
    decorate(c) {
      return {
        ...c,
        async *fetchHistory() {
          calls++;
          yield { messages: [message(3, { replyToNativeId: 'native-2' })], resume: 'opaque-page' };
          if (calls === 1) {
            first.resolve();
            await release.promise;
          }
          yield { messages: [message(2)], resume: null };
        },
      };
    },
  });
  t.after(async () => {
    release.resolve();
    await r.close();
  });
  r.include();
  await first.promise;
  const before = snap(r);
  const c = r.chatId(),
    a = r.accounts.get('alice') ?? 0;
  r.db.run(
    "CREATE TEMP TRIGGER final_withdraw_failure BEFORE INSERT ON action_log WHEN NEW.action='chat.withdraw' BEGIN SELECT RAISE(ABORT,'outer final log failure'); END",
  );
  assert.throws(
    () =>
      r.db.tx(() => {
        r.host.markWithdrawn(r.ctx(), a, c);
        record(r.ctx(), { action: 'chat.withdraw', subjectKind: 'chat', subjectId: c });
      }),
    /outer final log failure/,
  );
  assert.deepEqual(snap(r), before);
  r.db.run('DROP TRIGGER final_withdraw_failure');
  release.resolve();
  await r.host.settle();
  assert.ok(calls >= 2);
  const m = getMessages(r.ctx(), {});
  assert.equal(m.length, 2);
  assert.equal(
    m.find((v) => v.sentAt === message(3).sentAt)?.replyToId,
    m.find((v) => v.sentAt === message(2).sentAt)?.id,
  );
  assert.equal(
    r.db.get<{ sync_origin_state: string }>('SELECT sync_origin_state FROM account_chat')?.sync_origin_state,
    'none',
  );
});

test('include outer rollback and immediate equal-argument reinclude cannot dispatch the superseded queued job', async (t) => {
  let calls = 0;
  const r = await durabilityRig({
    decorate(c) {
      return {
        ...c,
        async *fetchHistory() {
          calls++;
          yield { messages: [], resume: null };
        },
      };
    },
  });
  t.after(() => r.close());
  assert.throws(
    () =>
      r.db.tx(() => {
        r.include();
        throw new Error('caller rollback');
      }),
    /caller rollback/,
  );
  assert.equal(r.db.get<{ n: number }>('SELECT count(*) AS n FROM account_chat')?.n, 0);
  r.include();
  await r.host.settle();
  assert.equal(calls, 1);
  assert.equal(
    r.db.get<{ sync_origin_state: string }>('SELECT sync_origin_state FROM account_chat')?.sync_origin_state,
    'none',
  );
});
