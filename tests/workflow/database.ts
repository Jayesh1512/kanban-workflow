import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { QueryResult, QueryResultRow } from 'pg';
import type { Database, SqlExecutor } from '../../src/shared/ports.js';
import { inputFixture, jobId, sourceText } from '../intelligence/fixtures.js';

/** Isolated PostgreSQL engine fixture, not a production database adapter or Telegram fake. */
export async function fixtureDatabase(additionalMigrations: URL[] = []) {
  const engine = new PGlite();
  await engine.exec(await readFile(new URL('../../db/migrations/001_initial.sql', import.meta.url), 'utf8'));
  await engine.exec(await readFile(new URL('../../db/migrations/202610170001_telegram_operations.sql', import.meta.url), 'utf8'));
  await engine.exec(await readFile(new URL('../../db/migrations/202610170002_decision_origins.sql', import.meta.url), 'utf8'));
  await engine.exec(await readFile(new URL('../../db/migrations/202610170003_contact_prospects.sql', import.meta.url), 'utf8'));
  await engine.exec(await readFile(new URL('../../db/migrations/202610230001_chat_intake_approvals.sql', import.meta.url), 'utf8'));
  await engine.exec(await readFile(new URL('../../db/migrations/202610230002_automatic_conversation_scope.sql', import.meta.url), 'utf8'));
  for (const migration of additionalMigrations) await engine.exec(await readFile(migration, 'utf8'));
  let tail: Promise<unknown> = Promise.resolve();
  const executor: SqlExecutor = { async query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>> {
    const result = await engine.query<R>(text, values); return { rows: result.rows, rowCount: result.rows.length || result.affectedRows || 0, fields: [], command: '', oid: 0 };
  } };
  const db: Database = { ...executor, async transaction<T>(work: (tx: SqlExecutor) => Promise<T>) {
    const result = tail.then(async () => { await engine.exec('BEGIN'); try { const value = await work(executor); await engine.exec('COMMIT'); return value; } catch (error) { await engine.exec('ROLLBACK'); throw error; } }); tail = result.catch(() => {}); return result;
  }, async withSessionLock<T>(): Promise<T> {
    // PGlite has no independently checked-out PostgreSQL sessions/advisory locks.
    // Lock-dependent workflows require the real PostgreSQL integration fixture.
    throw new Error('Session-lock workflows require a real PostgreSQL test database');
  }, async close() { await tail; await engine.close(); } };
  await db.query('INSERT INTO telegram_account(self_user_id) VALUES(99)');
  await db.query("INSERT INTO chats(id,kind,title,inclusion) VALUES(-1001,'supergroup','Cedar Labs','included')");
  const message = inputFixture().messages[0]!;
  await db.query('INSERT INTO messages(chat_id,id,sender_id,sent_at,text,sender_snapshot,peer_snapshot,forward_metadata) VALUES(-1001,1,7,$1,$2,$3,$4,$5)', [message.sentAt, sourceText, JSON.stringify(message.sender), JSON.stringify(message.peer), JSON.stringify(message.forward)]);
  await seedJob(db, jobId);
  return db;
}
export async function seedJob(db: SqlExecutor, id: string, chatId = '-1001', messageId = 1) {
  await db.query(`INSERT INTO analysis_jobs(id,chat_id,policy_version,mapping_version,dedupe_key)
    SELECT $1::uuid,id,policy_version,mapping_version,($1::uuid)::text FROM chats WHERE id=$2`, [id, chatId]);
  await db.query('INSERT INTO analysis_job_messages(job_id,chat_id,message_id,message_version) SELECT $1,chat_id,id,version FROM messages WHERE chat_id=$2 AND id=$3', [id, chatId, messageId]);
}
