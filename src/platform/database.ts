import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import pg from 'pg';
import type { Database, SqlExecutor } from '../shared/ports.js';

export class PgDatabase implements Database {
  readonly pool: pg.Pool;
  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 8, connectionTimeoutMillis: 3_000, idleTimeoutMillis: 10_000, query_timeout: 15_000, application_name: 'antseed-kanban' });
    // Idle pool errors are reflected by the next bounded health probe, not emitted unhandled.
    this.pool.on('error', () => {});
  }
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> {
    return this.pool.query<R>(text, values);
  }
  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  /** Dedicated session lock; remote I/O is permitted here, never inside transaction(). */
  async withLock<T>(key: string, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let locked = false;
    let broken = false;
    try {
      await client.query("SET lock_timeout = '10s'");
      await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key]);
      locked = true;
      return await work(client);
    } finally {
      if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]).catch(() => { broken = true; });
      await client.query('RESET lock_timeout').catch(() => { broken = true; });
      client.release(broken);
    }
  }
  async close(): Promise<void> { await this.pool.end(); }
}

export const defaultMigrationDirectory = fileURLToPath(new URL('../../db/migrations/', import.meta.url));

/** A file and its ledger insert commit together. Failed SQL cannot leave a ledger success. */
export async function migrate(db: PgDatabase, directory = defaultMigrationDirectory): Promise<void> {
  const names = (await readdir(directory)).filter((n) => /^\d[\w.-]*\.sql$/.test(n)).sort();
  await db.withLock('antseed:migrations', async (client) => {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const applied = await client.query<{ version: string; checksum: string }>('SELECT version,checksum FROM schema_migrations ORDER BY version');
    for (const row of applied.rows) if (!names.includes(row.version)) throw new Error(`Missing applied migration ${row.version}`);
    // Verify all applied checksums before applying any new migrations.
    const files = await Promise.all(names.map(async (version) => {
      const sql = await readFile(join(directory, version), 'utf8');
      return { version, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }));
    for (const row of applied.rows) if (files.find((f) => f.version === row.version)?.checksum !== row.checksum) throw new Error(`Migration checksum mismatch: ${row.version}`);
    for (const file of files) {
      if (applied.rows.some((r) => r.version === file.version)) continue;
      await client.query('BEGIN');
      try {
        await client.query(file.sql);
        await client.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [file.version, file.checksum]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    }
  });
}
