import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { Db } from '../contracts/index.ts';

export const h1Time = '2026-10-10T00:00:00.000Z';
export const h1Migration = '0004_h1_durability.sql';
export const oldMigrations = ['0001_init.sql', '0002_movement.sql', '0003_log_redaction_guard.sql'];

export function withH1File(fn: (path: string) => void): void {
  const dir = mkdtempSync(fileURLToPath(new URL('../../.h1-support-', import.meta.url)));
  try {
    fn(join(dir, 'synthetic.db'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function h1Probe(mode: string, path: string): void {
  const probe = fileURLToPath(new URL('./h1-migration-probe.ts', import.meta.url));
  const result = spawnSync(process.execPath, [probe, mode, path], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), mode);
}

export function seedH1(db: Db): void {
  db.tx(() => {
    db.run(
      'INSERT INTO teammate(id,username,display_name,password_hash,created_at) VALUES (1,?,?,?,?)',
      'synthetic',
      'Named Human',
      'not-a-credential',
      h1Time,
    );
    db.run("INSERT INTO contact(id,display_name,created_at) VALUES (1,'Synthetic sender',?)", h1Time);
    db.run(
      "INSERT INTO identity(id,channel,user_key,display_name,contact_id) VALUES (1,'fixture','sender','Sender',1)",
    );
    db.run(
      "INSERT INTO channel_account(id,teammate_id,channel,state,created_at) VALUES (1,1,'fixture','connected',?)",
      h1Time,
    );
    for (const [index, state] of ['idle', 'syncing', 'failed'].entries()) {
      const id = index + 1;
      db.run(
        "INSERT INTO chat(id,channel,chat_key,kind,title,created_at) VALUES (?,'fixture',?,'direct','Synthetic',?)",
        id,
        `chat-${id}`,
        h1Time,
      );
      db.run(
        `INSERT INTO account_chat(account_id,chat_id,native_chat_id,live_cursor,sync_state,sync_after,
          sync_since,sync_limit,sync_resume,sync_newest,sync_failed_since,agreement_stale_since)
          VALUES (1,?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        `native-chat-${id}`,
        `opaque-live-${id}`,
        state,
        `opaque-after-${id}`,
        h1Time,
        200,
        `opaque-resume-${id}`,
        `opaque-newest-${id}`,
        h1Time,
        h1Time,
      );
      db.run(
        `INSERT INTO chat_gap(id,account_id,chat_id,from_time,to_time,opened_at,closed_at,abandoned_at)
          VALUES (?,1,1,?,?,?,?,?)`,
        id,
        h1Time,
        '2026-10-10T01:00:00.000Z',
        h1Time,
        state === 'syncing' ? h1Time : null,
        state === 'failed' ? h1Time : null,
      );
    }
    insertH1Message(db, 1, 'native-source', '2026-10-10T00:02:00.000Z');
    insertH1Message(db, 2, 'native-target', '2026-10-10T00:01:00.000Z');
  });
}

export function insertH1Message(db: Db, id: number, native: string, sent: string): void {
  db.run(
    `INSERT INTO message(id,chat_id,message_key,sender_identity_id,sent_at,text,media,origin,stored_at)
      VALUES (?,1,?,1,?,?,'photo','history',?)`,
    id,
    `key-${id}`,
    sent,
    `synthetic-text-${id}`,
    h1Time,
  );
  db.run('INSERT INTO message_sighting(account_id,message_id,native_id) VALUES (1,?,?)', id, native);
}

export function snapshotH1(path: string): Record<string, unknown> {
  const sqlite = new DatabaseSync(path);
  try {
    const tables = ['account_chat', 'chat_gap', 'message', 'message_sighting', 'schema_migration'];
    return Object.fromEntries(
      tables.map((table) => [
        table,
        sqlite
          .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
          .all()
          .map((row) => ({ ...row })),
      ]),
    );
  } finally {
    sqlite.close();
  }
}
