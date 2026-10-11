import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { Db } from '../contracts/index.ts';
import { openDb } from './db.ts';
import {
  h1Migration,
  h1Probe,
  h1Time,
  insertH1Message,
  oldMigrations,
  seedH1,
  snapshotH1,
  withH1File,
} from './h1-test-fixture.ts';

function assertInstalled(db: Db): void {
  assert.deepEqual(
    db.all<{ name: string }>('SELECT name FROM schema_migration ORDER BY name').map((r) => r.name),
    [...oldMigrations, h1Migration],
  );
  for (const table of ['message_sighting', 'account_chat', 'chat_gap']) {
    assert.equal(db.get<{ strict: number }>('SELECT strict FROM pragma_table_list WHERE name=?', table)?.strict, 1);
  }
  assert.deepEqual(
    db.all<{ name: string }>("PRAGMA index_info('message_sighting_pending_reply')").map((r) => r.name),
    ['account_id', 'reply_to_native_id'],
  );
  assert.match(
    db.get<{ sql: string }>("SELECT sql FROM sqlite_schema WHERE name='message_sighting_pending_reply'")?.sql ?? '',
    /WHERE reply_to_native_id IS NOT NULL$/,
  );
}

test('H1 installed fresh file-backed schema registers exact fields and scoped partial index once', () => {
  withH1File((path) => {
    const db = openDb(path);
    try {
      assertInstalled(db);
      seedH1(db);
      assert.equal(
        db.get<{ n: number }>(
          "SELECT count(*) AS n FROM account_chat WHERE sync_origin_state='none' AND sync_gap_from IS NULL",
        )?.n,
        3,
      );
      assert.equal(
        db.get<{ n: number }>('SELECT count(*) AS n FROM message_sighting WHERE reply_to_native_id IS NULL')?.n,
        2,
      );
    } finally {
      db.close();
    }
    const before = snapshotH1(path);
    h1Probe('registered', path);
    assert.deepEqual(snapshotH1(path), before);
  });
});

test('H1 actual old install loses no request/page facts and marks ALL old gap statuses unknown', () => {
  withH1File((path) => {
    h1Probe('old', path);
    const before = snapshotH1(path);
    assertOldRollback(path, before);
    const db = openDb(path);
    try {
      assertInstalled(db);
      assert.equal((before.schema_migration as unknown[]).length, 3);
      assert.deepEqual(snapshotH1(path).message, before.message);
      const requests = db.all<Record<string, unknown>>('SELECT * FROM account_chat ORDER BY rowid');
      assert.deepEqual(
        requests.map(({ sync_gap_from, sync_origin_state, ...row }) => row),
        before.account_chat,
      );
      assert.deepEqual(
        requests.map((r) => [r.sync_gap_from, r.sync_origin_state]),
        [
          [null, 'none'],
          [null, 'legacy_unknown'],
          [null, 'legacy_unknown'],
        ],
      );
      const gaps = db.all<Record<string, unknown>>('SELECT * FROM chat_gap ORDER BY id');
      assert.deepEqual(
        gaps.map(({ bound_provenance, ...row }) => row),
        before.chat_gap,
      );
      assert.deepEqual(
        gaps.map((r) => r.bound_provenance),
        ['legacy_unknown', 'legacy_unknown', 'legacy_unknown'],
      );
      assert.deepEqual(
        db
          .all<Record<string, unknown>>('SELECT * FROM message_sighting ORDER BY rowid')
          .map(({ reply_to_native_id, ...row }) => {
            assert.equal(reply_to_native_id, null);
            return row;
          }),
        before.message_sighting,
      );
    } finally {
      db.close();
    }
    const after = snapshotH1(path);
    h1Probe('registered', path);
    assert.deepEqual(snapshotH1(path), after);
  });
});

function assertOldRollback(path: string, before: Record<string, unknown>): void {
  assert.deepEqual(snapshotH1(path), before);
  const raw = new DatabaseSync(path);
  try {
    for (const [table, column] of [
      ['message_sighting', 'reply_to_native_id'],
      ['account_chat', 'sync_gap_from'],
      ['account_chat', 'sync_origin_state'],
      ['chat_gap', 'bound_provenance'],
    ]) {
      assert.equal(
        raw.prepare('SELECT count(*) AS n FROM pragma_table_info(?) WHERE name=?').get(table ?? '', column ?? '')?.n,
        0,
      );
    }
    assert.equal(
      raw.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='message_sighting_pending_reply'").get()?.n,
      0,
    );
  } finally {
    raw.close();
  }
}

test('H1 actual openDb mid-DDL failure rolls back columns/index/data/registration then retries', () => {
  withH1File((path) => {
    h1Probe('old', path);
    const before = snapshotH1(path);
    h1Probe('mid', path);
    assertOldRollback(path, before);
    const db = openDb(path);
    try {
      assertInstalled(db);
    } finally {
      db.close();
    }
  });
});

test('H1 actual openDb registration failure rolls back completed DDL and legacy backfill', () => {
  withH1File((path) => {
    h1Probe('old', path);
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TRIGGER controlled_registration_failure BEFORE INSERT ON schema_migration
      WHEN NEW.name='0004_h1_durability.sql' BEGIN
        SELECT CASE WHEN
          (SELECT count(*) FROM account_chat WHERE sync_origin_state='legacy_unknown')=2
          AND (SELECT count(*) FROM chat_gap WHERE bound_provenance='legacy_unknown')=3
          THEN 1 ELSE RAISE(ABORT,'completed backfill not observed') END;
        SELECT RAISE(ABORT,'controlled registration failure'); END;`);
    raw.close();
    const before = snapshotH1(path);
    assert.throws(() => openDb(path), /controlled registration failure/);
    assertOldRollback(path, before);
    const cleanup = new DatabaseSync(path);
    cleanup.exec('DROP TRIGGER controlled_registration_failure');
    cleanup.close();
    const db = openDb(path);
    try {
      assertInstalled(db);
    } finally {
      db.close();
    }
  });
});

test('H1 old SQL after migration commits pages/resume but retains unavailable none/null and gap defaults', () => {
  withH1File((path) => {
    const db = openDb(path);
    try {
      seedH1(db);
      db.tx(() => {
        insertH1Message(db, 3, 'old-writer-native', '2026-10-10T00:03:00.000Z');
        db.run(
          "UPDATE account_chat SET sync_state='syncing',sync_after='old-after',sync_resume='old-page',sync_newest='old-newest' WHERE chat_id=1",
        );
        db.run(
          "INSERT INTO chat(id,channel,chat_key,kind,title,created_at) VALUES (4,'fixture','old-insert','direct','Synthetic',?)",
          h1Time,
        );
        db.run(
          "INSERT INTO account_chat(account_id,chat_id,native_chat_id,sync_state,sync_after,sync_since,sync_limit,sync_resume,sync_newest) VALUES (1,4,'old-chat','failed','after',?,200,'page','newest')",
          h1Time,
        );
        db.run(
          'INSERT INTO chat_gap(account_id,chat_id,from_time,to_time,opened_at,abandoned_at) VALUES (1,4,?,?,?,?)',
          h1Time,
          h1Time,
          h1Time,
          h1Time,
        );
      });
    } finally {
      db.close();
    }
    const committed = snapshotH1(path);
    h1Probe('registered', path);
    assert.deepEqual(snapshotH1(path), committed);
    const reopened = openDb(path);
    try {
      assert.deepEqual(
        reopened
          .all<{ sync_origin_state: string; sync_gap_from: null }>(
            'SELECT sync_origin_state,sync_gap_from FROM account_chat WHERE chat_id IN (1,4) ORDER BY chat_id',
          )
          .map((row) => ({ ...row })),
        [
          { sync_origin_state: 'none', sync_gap_from: null },
          { sync_origin_state: 'none', sync_gap_from: null },
        ],
      );
      assert.equal(
        reopened.get<{ sync_resume: string }>('SELECT sync_resume FROM account_chat WHERE chat_id=1')?.sync_resume,
        'old-page',
      );
      assert.equal(
        reopened.get<{ native_id: string }>('SELECT native_id FROM message_sighting WHERE message_id=3')?.native_id,
        'old-writer-native',
      );
      assert.equal(
        reopened.get<{ bound_provenance: string }>('SELECT bound_provenance FROM chat_gap WHERE chat_id=4')
          ?.bound_provenance,
        'legacy_unknown',
      );
      assert.equal(reopened.get<{ n: number }>('SELECT count(*) AS n FROM message')?.n, 3);
    } finally {
      reopened.close();
    }
  });
});

test('H1 coupled capture/clear, memberships, accepted empty reply and retained exact abandonment', () => {
  withH1File((path) => {
    const db = openDb(path);
    try {
      seedH1(db);
      for (const sql of [
        "UPDATE account_chat SET sync_origin_state='captured' WHERE chat_id=1",
        "UPDATE account_chat SET sync_gap_from='2026-10-10T00:00:00.000Z' WHERE chat_id=1",
        "UPDATE account_chat SET sync_origin_state='invalid' WHERE chat_id=1",
        'UPDATE account_chat SET sync_origin_state=NULL WHERE chat_id=1',
        "UPDATE chat_gap SET bound_provenance='invalid' WHERE id=1",
        'UPDATE chat_gap SET bound_provenance=NULL WHERE id=1',
      ])
        assert.throws(() => db.tx(() => db.run(sql)), { code: 'invalid' });
      db.tx(() => {
        db.run("UPDATE message_sighting SET reply_to_native_id='' WHERE message_id=1");
        db.run("UPDATE account_chat SET sync_state='syncing',sync_origin_state='queued' WHERE chat_id=1");
        db.run("UPDATE account_chat SET sync_origin_state='captured',sync_gap_from=? WHERE chat_id=1", h1Time);
        db.run(
          "INSERT INTO chat_gap(account_id,chat_id,from_time,to_time,opened_at,abandoned_at,bound_provenance) VALUES (1,1,?,?,?,?,'exact')",
          h1Time,
          h1Time,
          h1Time,
          h1Time,
        );
      });
      assert.throws(() => db.tx(() => db.run("UPDATE account_chat SET sync_origin_state='none' WHERE chat_id=1")), {
        code: 'invalid',
      });
      db.tx(() =>
        db.run(`UPDATE account_chat SET sync_state='idle',sync_after=NULL,sync_since=NULL,sync_limit=NULL,
        sync_resume=NULL,sync_newest=NULL,sync_failed_since=NULL,sync_origin_state='none',sync_gap_from=NULL WHERE chat_id=1`),
      );
    } finally {
      db.close();
    }
    const reopened = openDb(path);
    try {
      assert.equal(
        reopened.get<{ reply_to_native_id: string }>(
          'SELECT reply_to_native_id FROM message_sighting WHERE message_id=1',
        )?.reply_to_native_id,
        '',
      );
      assert.equal(
        reopened.get<{ n: number }>("SELECT count(*) AS n FROM message_sighting WHERE native_id='' AND account_id=1")
          ?.n,
        0,
      );
      assert.equal(
        reopened.get<{ n: number }>(
          "SELECT count(*) AS n FROM account_chat WHERE chat_id=1 AND sync_state='idle' AND sync_origin_state='none' AND sync_gap_from IS NULL AND sync_after IS NULL AND sync_since IS NULL AND sync_limit IS NULL AND sync_resume IS NULL AND sync_newest IS NULL AND sync_failed_since IS NULL",
        )?.n,
        1,
      );
      assert.deepEqual(
        {
          ...reopened.get<Record<string, unknown>>(
            'SELECT from_time,bound_provenance,abandoned_at FROM chat_gap WHERE id=4',
          ),
        },
        { from_time: h1Time, bound_provenance: 'exact', abandoned_at: h1Time },
      );
    } finally {
      reopened.close();
    }
  });
});

for (const lifecycle of ['closed_at', 'abandoned_at'] as const)
  test(`H1 shared storage retains original origin/page facts and pending replies through ${lifecycle}`, () => {
    withH1File((path) => {
      let db = openDb(path);
      try {
        seedH1(db);
        db.tx(() => db.run("UPDATE account_chat SET sync_state='syncing',sync_origin_state='queued' WHERE chat_id=1"));
        const queued = snapshotH1(path);
        db.close();
        h1Probe('registered', path);
        assert.deepEqual(snapshotH1(path), queued);
        db = openDb(path);
        db.tx(() => {
          db.run("UPDATE account_chat SET sync_origin_state='captured',sync_gap_from=? WHERE chat_id=1", h1Time);
          db.run("UPDATE message_sighting SET reply_to_native_id='native-target' WHERE message_id=1");
          insertH1Message(db, 3, 'committed-page-native', '2026-10-10T00:03:00.000Z');
          db.run("UPDATE account_chat SET sync_resume='page-one',sync_newest='page-newest' WHERE chat_id=1");
        });
        const page = snapshotH1(path);
        db.close();
        h1Probe('registered', path);
        assert.deepEqual(snapshotH1(path), page);
        db = openDb(path);
        const request = db.get<Record<string, unknown>>('SELECT * FROM account_chat WHERE chat_id=1');
        assert.ok(request);
        assert.deepEqual(
          [
            request.sync_after,
            request.sync_since,
            request.sync_limit,
            request.sync_resume,
            request.sync_newest,
            request.sync_gap_from,
            request.sync_origin_state,
          ],
          ['opaque-after-1', h1Time, 200, 'page-one', 'page-newest', h1Time, 'captured'],
        );
        db.tx(() => {
          const gap = db.run(
            "INSERT INTO chat_gap(account_id,chat_id,from_time,to_time,opened_at,bound_provenance) VALUES (1,1,?,?,?,'exact')",
            h1Time,
            '2026-10-10T01:00:00.000Z',
            h1Time,
          ).lastInsertRowid;
          db.run(`UPDATE chat_gap SET ${lifecycle}=? WHERE id=?`, h1Time, gap);
          db.run(`UPDATE account_chat SET sync_state='idle',sync_after=NULL,sync_since=NULL,sync_limit=NULL,
            sync_resume=NULL,sync_newest=NULL,sync_failed_since=NULL,sync_origin_state='none',sync_gap_from=NULL WHERE chat_id=1`);
        });
        const completed = snapshotH1(path);
        db.close();
        h1Probe('registered', path);
        assert.deepEqual(snapshotH1(path), completed);
        db = openDb(path);
        assert.equal(
          db.get<{ reply_to_native_id: string }>('SELECT reply_to_native_id FROM message_sighting WHERE message_id=1')
            ?.reply_to_native_id,
          'native-target',
        );
        assert.equal(db.get<{ n: number }>('SELECT count(*) AS n FROM message')?.n, 3);
        assert.deepEqual(
          {
            ...db.get<Record<string, unknown>>(
              `SELECT from_time,bound_provenance,${lifecycle} FROM chat_gap WHERE id=4`,
            ),
          },
          { from_time: h1Time, bound_provenance: 'exact', [lifecycle]: h1Time },
        );
      } finally {
        db.close();
      }
    });
  });
