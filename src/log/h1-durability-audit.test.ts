import assert from 'node:assert/strict';
import test from 'node:test';
import type { Ctx, LogEntryInput } from '../contracts/index.ts';
import { IdSchema, IsoTimeSchema } from '../contracts/index.ts';
import { openDb } from '../store/db.ts';
import { h1Time, seedH1, snapshotH1, withH1File } from '../store/h1-test-fixture.ts';
import { history, record, redact } from './index.ts';

function context(path: string): Ctx {
  const db = openDb(path);
  seedH1(db);
  return { db, actor: { kind: 'system' }, canReadText: true, now: () => new Date(h1Time) };
}

function pending(): LogEntryInput {
  return {
    action: 'message.reply_pending',
    subjectKind: 'message',
    subjectId: 1,
    after: { accountId: 1, recordedAt: h1Time },
    messageIds: [1],
  };
}

function link(): LogEntryInput {
  return {
    action: 'message.reply_link',
    subjectKind: 'message',
    subjectId: 1,
    before: { replyToId: null },
    after: { accountId: 1, replyToId: 2, linkedAt: h1Time },
    messageIds: [1, 2],
  };
}

function queue(): LogEntryInput {
  return { action: 'chat.sync_queue', subjectKind: 'chat', subjectId: 2, after: { accountId: 1, queuedAt: h1Time } };
}

// These explicit SQL/record fixtures prove shared support, not host dispatch or reply resolution.
function recordTransitions(ctx: Ctx): LogEntryInput[] {
  const human: Ctx = { ...ctx, actor: { kind: 'teammate', id: 1 } };
  const witness = ctx.db.get<{ id: number; sent_at: string }>(
    'SELECT id,sent_at FROM message WHERE chat_id=1 ORDER BY sent_at DESC,id DESC LIMIT 1',
  );
  assert.ok(witness);
  const start: LogEntryInput = {
    action: 'chat.sync_start',
    subjectKind: 'chat',
    subjectId: 1,
    after: { accountId: 1, fromTime: witness.sent_at, startedAt: h1Time },
    messageIds: [witness.id],
  };
  const page: LogEntryInput = {
    action: 'chat.sync_page',
    subjectKind: 'chat',
    subjectId: 1,
    after: { accountId: 1, committedAt: h1Time },
    messageIds: [1, 2],
  };
  const failure: LogEntryInput = {
    action: 'chat.sync_failure',
    subjectKind: 'chat',
    subjectId: 1,
    after: { accountId: 1, failedAt: h1Time },
  };
  const complete: LogEntryInput = {
    action: 'chat.sync_complete',
    subjectKind: 'chat',
    subjectId: 2,
    after: { accountId: 1, completedAt: h1Time },
  };
  ctx.db.tx(() => {
    ctx.db.run("UPDATE message_sighting SET reply_to_native_id='native-target' WHERE message_id=1");
    record(ctx, pending());
  });
  for (const actor of [human, ctx])
    ctx.db.tx(() => {
      ctx.db.run("UPDATE account_chat SET sync_origin_state='queued',sync_state='syncing' WHERE chat_id=2");
      record(actor, queue());
    });
  ctx.db.tx(() => {
    ctx.db.run("UPDATE account_chat SET sync_origin_state='captured',sync_gap_from=? WHERE chat_id=1", witness.sent_at);
    record(ctx, start);
  });
  const stored = ctx.db.all<Record<string, unknown>>('SELECT * FROM message ORDER BY id');
  ctx.db.tx(() => {
    ctx.db.run('UPDATE message SET reply_to_message_id=2 WHERE id=1');
    ctx.db.run('UPDATE message_sighting SET reply_to_native_id=NULL WHERE message_id=1');
    record(ctx, link());
    ctx.db.run("UPDATE account_chat SET sync_resume='duplicate-page' WHERE chat_id=1");
    record(ctx, page);
  });
  // A duplicate-only page changes no identity/text/version/processing facts; both link endpoints are cited.
  const linked = ctx.db.all<Record<string, unknown>>('SELECT * FROM message ORDER BY id');
  assert.deepEqual(
    linked.map((row) => ({ ...row, reply_to_message_id: null })),
    stored.map((row) => ({ ...row })),
  );
  for (let occurrence = 0; occurrence < 2; occurrence++)
    ctx.db.tx(() => {
      ctx.db.run("UPDATE account_chat SET sync_state='failed',sync_failed_since=? WHERE chat_id=1", h1Time);
      record(ctx, failure);
    });
  assert.equal(ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM chat_gap WHERE chat_id=2')?.n, 0);
  ctx.db.tx(() => {
    ctx.db.run("UPDATE account_chat SET sync_state='idle',sync_origin_state='none',sync_gap_from=NULL WHERE chat_id=2");
    record(ctx, complete);
  });
  return [pending(), queue(), queue(), start, link(), page, failure, failure, complete];
}

test('H1 seven actual audit names retain exact logical IDs/ISO times/actors and all message witnesses', () => {
  withH1File((path) => {
    const ctx = context(path);
    try {
      const examples = recordTransitions(ctx);
      const rows = history(ctx, {}).reverse();
      assert.deepEqual(
        [...new Set(rows.map((row) => row.action))].sort(),
        [
          'message.reply_pending',
          'message.reply_link',
          'chat.sync_queue',
          'chat.sync_start',
          'chat.sync_page',
          'chat.sync_failure',
          'chat.sync_complete',
        ].sort(),
      );
      for (const [index, entry] of rows.entries()) {
        const example = examples[index];
        assert.ok(example);
        assert.equal(entry.action, example.action);
        assert.equal(entry.subjectKind, example.subjectKind);
        assert.equal(entry.subjectId, example.subjectId);
        assert.deepEqual(entry.before, example.before ?? null);
        assert.deepEqual(entry.after, example.after);
        assert.deepEqual(entry.messageIds, example.messageIds ?? []);
        assert.deepEqual(
          entry.actor,
          index === 1 ? { kind: 'teammate', id: 1, name: 'Named Human' } : { kind: 'system', id: null, name: 'system' },
        );
        assert.equal(entry.at, h1Time);
        assert.equal(entry.reason, '');
        assert.equal(entry.correctsId, null);
        assert.equal(entry.followsHumanOverride, false);
        assert.equal(entry.redacted, false);
        for (const [key, value] of Object.entries(entry.after as Record<string, unknown>)) {
          assert.equal((key.endsWith('Id') ? IdSchema : IsoTimeSchema).safeParse(value).success, true);
        }
      }
      assert.equal(
        ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM action_log WHERE decision_id IS NOT NULL')?.n,
        0,
      );
      assert.deepEqual(history(ctx, { action: 'message.reply_link' })[0]?.messageIds, [1, 2]);
      assert.deepEqual(history(ctx, { action: 'chat.sync_start' })[0]?.messageIds, [1]);
      assert.deepEqual(history(ctx, { action: 'chat.sync_page' })[0]?.messageIds, [1, 2]);
      assert.equal(history(ctx, { action: 'chat.sync_failure' }).length, 2);
      const raw = JSON.stringify(ctx.db.all('SELECT * FROM action_log'));
      for (const marker of [
        'native-source',
        'native-target',
        'synthetic-text',
        'opaque-',
        'duplicate-page',
        'SDK-session',
        'raw-error',
      ])
        assert.equal(raw.includes(marker), false, marker);
    } finally {
      ctx.db.close();
    }
  });
});

test('H1 empty-chat sync_start has validated original time and no invented message witness', () => {
  withH1File((path) => {
    const ctx = context(path);
    try {
      assert.equal(ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM message WHERE chat_id=2')?.n, 0);
      ctx.db.tx(() => {
        ctx.db.run("UPDATE account_chat SET sync_origin_state='captured',sync_gap_from=sync_since WHERE chat_id=2");
        record(ctx, {
          action: 'chat.sync_start',
          subjectKind: 'chat',
          subjectId: 2,
          after: { accountId: 1, fromTime: h1Time, startedAt: h1Time },
        });
      });
      assert.deepEqual(history(ctx, {})[0]?.messageIds, []);
      assert.deepEqual(history(ctx, {})[0]?.after, { accountId: 1, fromTime: h1Time, startedAt: h1Time });
    } finally {
      ctx.db.close();
    }
  });
});

for (const [selected, count] of [
  [1, 4],
  [2, 2],
])
  test(`H1 actual redact selects ${selected === 1 ? 'source' : 'target'} citations and retains only audit metadata`, () => {
    withH1File((path) => {
      const ctx = context(path);
      try {
        recordTransitions(ctx);
        const before = history(ctx, {});
        const selection = {
          messageIds: [selected ?? 0],
          decisionIds: [],
          cardIds: [],
          reviewItemIds: [],
          contactIds: [],
          companyIds: [],
        };
        assert.throws(
          () =>
            ctx.db.tx(() => {
              assert.equal(redact(ctx, selection), count);
              ctx.db.run('UPDATE message SET reply_to_message_id=NULL WHERE id=1');
              throw new Error('controlled outer rollback');
            }),
          /controlled outer rollback/,
        );
        assert.deepEqual(history(ctx, {}), before);
        assert.equal(
          ctx.db.get<{ reply_to_message_id: number }>('SELECT reply_to_message_id FROM message WHERE id=1')
            ?.reply_to_message_id,
          2,
        );
        assert.equal(redact(ctx, selection), count);
        const after = history(ctx, {});
        assert.equal(after.find((row) => row.action === 'message.reply_link')?.redacted, true);
        assert.equal(after.find((row) => row.action === 'message.reply_pending')?.redacted, selected === 1);
        for (const entry of after) {
          const original = before.find((row) => row.id === entry.id);
          assert.ok(original);
          if (!entry.redacted) assert.deepEqual(entry, original);
          else
            assert.deepEqual(entry, {
              ...original,
              before: null,
              after: null,
              reason: '',
              messageIds: [],
              redacted: true,
            });
        }
        assert.equal(redact(ctx, selection), 0);
      } finally {
        ctx.db.close();
      }
    });
  });

test('H1 reply and sync bookkeeping have zero card changes; attach/detach and card.* controls count', () => {
  withH1File((path) => {
    const ctx = context(path);
    const countSql =
      "SELECT count(*) AS n FROM action_log WHERE action GLOB 'card.*' OR action IN ('message.attach','message.detach')";
    try {
      ctx.db.tx(() => {
        record(ctx, pending());
        record(ctx, link());
      });
      assert.equal(ctx.db.get<{ n: number }>(countSql)?.n, 0);
      recordTransitions(ctx);
      assert.equal(ctx.db.get<{ n: number }>(countSql)?.n, 0);
      assert.equal(
        ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM action_log WHERE action GLOB 'message.*'")?.n,
        4,
      );
      ctx.db.tx(() => record(ctx, { action: 'message.attach', subjectKind: 'card', subjectId: 1, messageIds: [1] }));
      assert.equal(ctx.db.get<{ n: number }>(countSql)?.n, 1);
      ctx.db.tx(() => record(ctx, { action: 'message.detach', subjectKind: 'card', subjectId: 1, messageIds: [1] }));
      assert.equal(ctx.db.get<{ n: number }>(countSql)?.n, 2);
      ctx.db.tx(() => record(ctx, { action: 'card.move', subjectKind: 'card', subjectId: 1 }));
      assert.equal(ctx.db.get<{ n: number }>(countSql)?.n, 3);
    } finally {
      ctx.db.close();
    }
  });
});

test('H1 actual record failure rolls back pending/link/request/origin/gap state AND prior nested logs', () => {
  withH1File((path) => {
    const ctx = context(path);
    try {
      const before = snapshotH1(path);
      assert.throws(
        () =>
          ctx.db.tx(() => {
            ctx.db.run("UPDATE message_sighting SET reply_to_native_id='native-target' WHERE message_id=1");
            record(ctx, pending());
            ctx.db.run('UPDATE message SET reply_to_message_id=2 WHERE id=1');
            ctx.db.tx(() => record(ctx, link()));
            ctx.db.run(
              "UPDATE account_chat SET sync_state='syncing',sync_resume='rolled-back-page',sync_origin_state='captured',sync_gap_from=? WHERE chat_id=1",
              h1Time,
            );
            ctx.db.run(
              "INSERT INTO chat_gap(account_id,chat_id,from_time,to_time,opened_at,bound_provenance) VALUES (1,1,?,?,?,'exact')",
              h1Time,
              h1Time,
              h1Time,
            );
            record(ctx, { ...queue(), subjectId: 0 });
          }),
        { code: 'invalid', message: 'Invalid action log entry' },
      );
      assert.deepEqual(snapshotH1(path), before);
      assert.deepEqual(history(ctx, {}), []);
    } finally {
      ctx.db.close();
    }
  });
});

for (const [entry, mutation] of [
  [pending(), "UPDATE message_sighting SET reply_to_native_id='native-target' WHERE message_id=1"],
  [link(), 'UPDATE message SET reply_to_message_id=2 WHERE id=1'],
  [queue(), "UPDATE account_chat SET sync_state='syncing',sync_origin_state='queued' WHERE chat_id=2"],
  [
    {
      action: 'chat.sync_start',
      subjectKind: 'chat',
      subjectId: 1,
      after: { accountId: 1, fromTime: '2026-10-10T00:02:00.000Z', startedAt: h1Time },
      messageIds: [1],
    },
    "UPDATE account_chat SET sync_origin_state='captured',sync_gap_from='2026-10-10T00:02:00.000Z' WHERE chat_id=1",
  ],
  [
    {
      action: 'chat.sync_page',
      subjectKind: 'chat',
      subjectId: 1,
      after: { accountId: 1, committedAt: h1Time },
      messageIds: [1, 2],
    },
    "UPDATE account_chat SET sync_resume='uncommitted-page',sync_newest='uncommitted-newest' WHERE chat_id=1",
  ],
  [
    { action: 'chat.sync_failure', subjectKind: 'chat', subjectId: 1, after: { accountId: 1, failedAt: h1Time } },
    "UPDATE account_chat SET sync_state='failed',sync_failed_since='2026-10-10T00:00:00.000Z' WHERE chat_id=1",
  ],
  [
    { action: 'chat.sync_complete', subjectKind: 'chat', subjectId: 1, after: { accountId: 1, completedAt: h1Time } },
    "UPDATE account_chat SET sync_state='idle',sync_resume=NULL,sync_newest=NULL,sync_origin_state='none',sync_gap_from=NULL WHERE chat_id=1",
  ],
] satisfies [LogEntryInput, string][])
  test(`H1 actual ${entry.action} INSERT fault rolls back its state and prior nested gap/log writes`, () => {
    withH1File((path) => {
      const ctx = context(path);
      try {
        if (entry.action === 'message.reply_link')
          ctx.db.tx(() =>
            ctx.db.run("UPDATE message_sighting SET reply_to_native_id='native-target' WHERE message_id=1"),
          );
        if (['chat.sync_page', 'chat.sync_failure', 'chat.sync_complete'].includes(entry.action))
          ctx.db.tx(() =>
            ctx.db.run(
              "UPDATE account_chat SET sync_state='syncing',sync_origin_state='captured',sync_gap_from=? WHERE chat_id=1",
              h1Time,
            ),
          );
        ctx.db.run(`CREATE TRIGGER controlled_audit_failure BEFORE INSERT ON action_log
          WHEN NEW.action='${entry.action}' BEGIN SELECT RAISE(ABORT,'controlled audit insertion failure'); END`);
        const before = snapshotH1(path);
        assert.throws(
          () =>
            ctx.db.tx(() => {
              ctx.db.tx(() => {
                const gap = ctx.db.run(
                  "INSERT INTO chat_gap(account_id,chat_id,from_time,to_time,opened_at,bound_provenance) VALUES (1,1,?,?,?,'exact')",
                  h1Time,
                  h1Time,
                  h1Time,
                ).lastInsertRowid;
                record(ctx, {
                  action: 'chat.gap_open',
                  subjectKind: 'chat',
                  subjectId: 1,
                  after: { accountId: 1, gapId: gap, fromTime: h1Time, toTime: h1Time },
                });
              });
              ctx.db.run(mutation);
              if (entry.action === 'message.reply_link')
                ctx.db.run('UPDATE message_sighting SET reply_to_native_id=NULL WHERE message_id=1');
              record(ctx, entry);
            }),
          /controlled audit insertion failure/,
        );
        assert.deepEqual(snapshotH1(path), before);
        assert.deepEqual(history(ctx, {}), []);
      } finally {
        ctx.db.close();
      }
    });
  });
