import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDb } from './db.ts';

// F0 infrastructure checks run before testApp's feature dependencies have bodies.
test('F0 complete migrations enforce STRICT, foreign keys, FTS and secure deletion', () => {
  const db = openDb(':memory:');
  try {
    assert.deepEqual(
      db.all<{ name: string }>('SELECT name FROM schema_migration ORDER BY name').map((r) => r.name),
      ['0001_init.sql', '0002_movement.sql'],
    );
    assert.equal(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys, 1);
    assert.equal(db.get<{ secure_delete: number }>('PRAGMA secure_delete')?.secure_delete, 1);
    const tables = db.all<{ name: string; strict: number }>('PRAGMA table_list');
    for (const table of tables.filter((t) => !t.name.startsWith('sqlite_') && !t.name.startsWith('message_fts')))
      assert.equal(table.strict, 1, table.name);
    assert.throws(
      () =>
        db.run("INSERT INTO lane(name,sop,position,created_at) VALUES ('bad','sop','text','2026-09-01T00:00:00.000Z')"),
      /cannot store TEXT/,
    );
    assert.throws(() => db.run('INSERT INTO stage(lane_id,name,position) VALUES (999,?,0)', 'Missing'), /FOREIGN KEY/);
    db.tx(() => {
      db.run(
        "INSERT INTO chat(channel,chat_key,kind,title,created_at) VALUES ('fixture','chat','direct','Synthetic','2026-09-01T00:00:00.000Z')",
      );
      db.run("INSERT INTO contact(display_name,created_at) VALUES ('Synthetic','2026-09-01T00:00:00.000Z')");
      db.run(
        "INSERT INTO identity(channel,user_key,display_name,contact_id) VALUES ('fixture','outside','Synthetic',1)",
      );
      db.run(
        "INSERT INTO message(chat_id,message_key,sender_identity_id,sent_at,text,origin,stored_at) VALUES (1,'m',1,'2026-09-01T00:00:00.000Z','firstmarker','live','2026-09-01T00:00:00.000Z')",
      );
    });
    assert.equal(db.all("SELECT rowid FROM message_fts WHERE message_fts MATCH 'firstmarker'").length, 1);
    db.tx(() => db.run("UPDATE message SET text='secondmarker' WHERE id=1"));
    assert.equal(db.all("SELECT rowid FROM message_fts WHERE message_fts MATCH 'firstmarker'").length, 0);
    assert.equal(db.all("SELECT rowid FROM message_fts WHERE message_fts MATCH 'secondmarker'").length, 1);
    db.tx(() => {
      db.run(
        "INSERT INTO decision(message_id,message_version,outcome,disposition,confidence,reason,lane_versions,model,raw,decided_at) VALUES (1,1,'none','none',1,'synthetic','{}','scripted','{}','2026-09-01T00:00:00.000Z')",
      );
      db.run("INSERT INTO movement_decision VALUES (1,1,'stay','{}','{}')");
      db.run('DELETE FROM message WHERE id=1');
    });
    assert.equal(db.all('SELECT * FROM movement_decision').length, 0);
    assert.equal(db.all("SELECT rowid FROM message_fts WHERE message_fts MATCH 'secondmarker'").length, 0);
  } finally {
    db.close();
  }
});

test('F0 Db.tx rollback joins nested calls and rejects async callbacks', () => {
  const db = openDb(':memory:');
  try {
    assert.throws(
      () =>
        db.tx(() => {
          db.run("INSERT INTO setting VALUES ('one','1')");
          db.tx(() => db.run("INSERT INTO setting VALUES ('two','2')"));
          throw new Error('synthetic failure');
        }),
      /synthetic failure/,
    );
    assert.equal(db.all('SELECT * FROM setting').length, 0);
    assert.throws(() => db.tx(async () => 1), /synchronous/);
    assert.throws(
      () =>
        db.tx(() =>
          db.tx(async () => {
            db.run("INSERT INTO setting VALUES ('escaped','true')");
          }),
        ),
      /synchronous/,
    );
    assert.equal(db.all('SELECT * FROM setting').length, 0);
    db.tx(() => db.run("INSERT INTO setting VALUES ('three','3')"));
    assert.equal(db.all('SELECT * FROM setting').length, 1);
  } finally {
    db.close();
  }
});

test('F0 named migrations run once across reopening a WAL database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-f0-'));
  const path = join(dir, 'synthetic.db');
  try {
    const first = openDb(path);
    first.tx(() => first.run("INSERT INTO setting VALUES ('synthetic','true')"));
    first.close();
    const second = openDb(path);
    assert.equal(second.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode, 'wal');
    assert.equal(second.all('SELECT * FROM schema_migration').length, 2);
    assert.equal(second.all('SELECT * FROM setting').length, 1);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
