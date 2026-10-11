import assert from 'node:assert/strict';
import test from 'node:test';
import { openDb } from './db.ts';
import { h1Time, insertH1Message, seedH1, withH1File } from './h1-test-fixture.ts';

test('H1 actual indexed pending storage separates accounts and existing FKs preserve source/target lifecycle', () => {
  withH1File((path) => {
    const db = openDb(path);
    try {
      seedH1(db);
      db.tx(() => {
        db.run(
          "INSERT INTO channel_account(id,teammate_id,channel,state,created_at) VALUES (2,1,'second-fixture','connected',?)",
          h1Time,
        );
        insertH1Message(db, 3, 'second-source', h1Time);
        db.run('DELETE FROM message_sighting WHERE message_id=3');
        db.run(
          "INSERT INTO message_sighting(account_id,message_id,native_id,reply_to_native_id) VALUES (2,3,'second-source','native-target')",
        );
        db.run("UPDATE message_sighting SET reply_to_native_id='native-target' WHERE message_id=1");
      });
      for (const [account, source] of [
        [1, 1],
        [2, 3],
      ] as const) {
        assert.deepEqual(
          db
            .all<{ message_id: number }>(
              'SELECT message_id FROM message_sighting WHERE account_id=? AND reply_to_native_id=?',
              account,
              'native-target',
            )
            .map((r) => r.message_id),
          [source],
        );
      }
      assert.ok(
        db
          .all<{ detail: string }>(
            'EXPLAIN QUERY PLAN SELECT message_id FROM message_sighting WHERE account_id=? AND reply_to_native_id=?',
            1,
            'native-target',
          )
          .some((row) => row.detail.includes('message_sighting_pending_reply')),
      );
      db.tx(() => {
        db.run('UPDATE message SET reply_to_message_id=2 WHERE id=1');
        db.run('UPDATE message_sighting SET reply_to_native_id=NULL WHERE message_id=1');
        db.run('DELETE FROM message WHERE id=2');
      });
      assert.equal(
        db.get<{ reply_to_message_id: null }>('SELECT reply_to_message_id FROM message WHERE id=1')
          ?.reply_to_message_id,
        null,
      );
      assert.equal(
        db.get<{ reply_to_native_id: null }>('SELECT reply_to_native_id FROM message_sighting WHERE message_id=1')
          ?.reply_to_native_id,
        null,
      );
      assert.equal(
        db.get<{ reply_to_native_id: string }>('SELECT reply_to_native_id FROM message_sighting WHERE message_id=3')
          ?.reply_to_native_id,
        'native-target',
      );
      db.tx(() => db.run('DELETE FROM message WHERE id=3'));
      assert.equal(db.get<{ n: number }>('SELECT count(*) AS n FROM message_sighting WHERE message_id=3')?.n, 0);
    } finally {
      db.close();
    }
  });
});
