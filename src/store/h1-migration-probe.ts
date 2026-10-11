// Child-only builtin seams: production migration bytes and openDb are never replaced.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import { h1Migration, seedH1 } from './h1-test-fixture.ts';

const [mode, path] = process.argv.slice(2);
assert.ok(path);
if (mode === 'old') {
  const readDirectory = fs.readdirSync;
  fs.readdirSync = ((directory: fs.PathLike) => {
    const names = readDirectory(directory);
    return names.filter((name) => name !== h1Migration);
  }) as typeof fs.readdirSync;
  syncBuiltinESMExports();
  try {
    const db = openDb(path);
    try {
      seedH1(db);
    } finally {
      db.close();
    }
  } finally {
    fs.readdirSync = readDirectory;
    syncBuiltinESMExports();
  }
} else {
  const exec = DatabaseSync.prototype.exec;
  let intercepted = 0;
  DatabaseSync.prototype.exec = function (sql: string) {
    if (sql.startsWith('ALTER TABLE message_sighting ADD COLUMN reply_to_native_id')) {
      intercepted++;
      if (mode === 'mid') {
        exec.call(this, sql.slice(0, sql.indexOf('UPDATE account_chat')));
        // Observe actual earlier DDL in the same openDb transaction before aborting.
        assert.equal(
          this.prepare(
            "SELECT count(*) AS n FROM pragma_table_info('account_chat') WHERE name='sync_origin_state'",
          ).get()?.n,
          1,
        );
        assert.equal(
          this.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='message_sighting_pending_reply'").get()?.n,
          1,
        );
        throw new Error('controlled mid-migration failure');
      }
      if (mode === 'registered') throw new Error('registered migration reran raw ALTER');
    }
    return exec.call(this, sql);
  };
  try {
    if (mode === 'mid') {
      assert.throws(() => openDb(path), /controlled mid-migration failure/);
      assert.equal(intercepted, 1);
    } else {
      const db = openDb(path);
      db.close();
      assert.equal(intercepted, 0);
    }
  } finally {
    DatabaseSync.prototype.exec = exec;
  }
}
console.log(mode);
