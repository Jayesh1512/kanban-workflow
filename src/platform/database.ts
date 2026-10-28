import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import type { Database, SqlExecutor } from '../shared/ports.js';
import { DomainError } from '../shared/api.js';

interface SessionScope {
  client: pg.PoolClient;
  sql: SqlExecutor;
  controller: AbortController;
  active: boolean;
  broken: boolean;
  failure: DomainError | null;
  inTransaction: boolean;
  locks: Set<string>;
}

const sessionLost = () => new DomainError('upstream_unavailable', 'Database session lost; remote outcome may be unknown; reconcile before retrying', true);

export class PgDatabase implements Database {
  readonly pool: pg.Pool;
  private readonly sessions = new AsyncLocalStorage<SessionScope>();
  constructor(connectionString: string) {
    const endpoint = new URL(connectionString);
    const supabase = /(^|\.)supabase\.(com|co)$/.test(endpoint.hostname);
    if (supabase && endpoint.port === '6543') {
      throw new Error('Use a Supabase direct or session-pooler connection on port 5432; transaction pooling cannot preserve application locks');
    }
    const schema = endpoint.searchParams.get('schema');
    endpoint.searchParams.delete('schema');
    const option = (name: string, fallback: number, max: number) => {
      const raw = endpoint.searchParams.get(name); endpoint.searchParams.delete(name);
      const value = raw === null ? fallback : Number(raw);
      if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid database ${name}`);
      return value;
    };
    const max = option('pool_max', 8, 32), connectionTimeoutMillis = option('connect_timeout_ms', 3_000, 60_000);
    // Supabase session-pooler queries cross a WAN and can briefly queue behind
    // the bounded application pool. Keep local failures fast while allowing a
    // single remote read enough time to complete instead of degrading replay.
    const queryTimeoutMillis = option('query_timeout_ms', supabase ? 45_000 : 15_000, 120_000);
    this.pool = new pg.Pool({ connectionString: endpoint.toString(), max, connectionTimeoutMillis, idleTimeoutMillis: 10_000, query_timeout: queryTimeoutMillis, application_name: 'antseed-kanban',
      ...(schema ? { onConnect: async (client: pg.ClientBase) => {
        // Explicit SQL avoids relying on pooler support for startup options.
        // Never fall back to public and migrate the wrong schema.
        await client.query(`SET search_path TO "${schema.replaceAll('"','""')}", public`);
        const selected = await client.query<{ schema: string }>('SELECT current_schema() AS schema');
        if (selected.rows[0]?.schema !== schema) throw new Error('Configured database schema is unavailable');
      } } : {}),
    });
    // Idle pool errors are reflected by the next bounded health probe, not emitted unhandled.
    this.pool.on('error', () => {});
  }
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> {
    const scope = this.sessions.getStore();
    return scope ? scope.sql.query<R>(text, values) : this.pool.query<R>(text, values);
  }
  /** Only the root scope checks out/releases. Late callbacks retain a fenced, unusable scope. */
  private async inSession<T>(work: (scope: SessionScope) => Promise<T>): Promise<T> {
    const existing = this.sessions.getStore();
    if (existing) { this.assertSession(existing); return work(existing); }
    const client = await this.pool.connect();
    let rejectLost!: (error: DomainError) => void;
    const lost = new Promise<never>((_resolve, reject) => { rejectLost = reject; });
    const scope: SessionScope = { client, sql: { query: async <R extends pg.QueryResultRow>(text: string, values?: unknown[]) => {
      this.assertSession(scope);
      try {
        const result = await client.query<R>(text, values);
        this.assertSession(scope);
        return result;
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        if (/^08|^57P0[123]$|^(ECONNRESET|EPIPE|ETIMEDOUT)$/.test(code)) onLoss();
        throw scope.failure ?? error;
      }
    } }, controller: new AbortController(), active: true, broken: false, failure: null, inTransaction: false, locks: new Set() };
    const onLoss = () => {
      if (!scope.active || scope.failure) return;
      scope.broken = true;
      scope.failure = sessionLost();
      scope.controller.abort(scope.failure);
      rejectLost(scope.failure);
    };
    // pg-pool removes its idle listener on checkout. Keep a listener during remote-I/O waits too.
    client.on('error', onLoss);
    client.on('end', onLoss);
    try {
      const value = await Promise.race([this.sessions.run(scope, () => Promise.resolve().then(() => work(scope))), lost]);
      this.assertSession(scope);
      return value;
    } catch (error) { throw scope.failure ?? error; }
    finally {
      scope.active = false;
      scope.controller.abort(scope.failure ?? new DomainError('conflict', 'Database session scope has closed'));
      // release installs pg-pool's idle listener before our temporary listener is removed.
      client.release(scope.broken || scope.failure !== null);
      client.removeListener('error', onLoss);
      client.removeListener('end', onLoss);
    }
  }
  private assertSession(scope: SessionScope): void {
    if (scope.failure) throw scope.failure;
    if (scope.broken) throw sessionLost();
    if (!scope.active) throw new DomainError('conflict', 'Database session scope has closed');
  }
  /** Adapter HTTP uses the same loss signal as the shared callback. */
  get sessionSignal(): AbortSignal | undefined {
    const scope = this.sessions.getStore();
    if (scope) this.assertSession(scope);
    return scope?.controller.signal;
  }
  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.inSession(async (scope) => {
      if (scope.inTransaction) throw new DomainError('conflict', 'Nested database transactions are not supported');
      scope.inTransaction = true;
      try {
        await scope.sql.query('BEGIN');
        const value = await work(scope.sql);
        await scope.sql.query('COMMIT');
        return value;
      } catch (error) {
        if (!scope.failure) await scope.sql.query('ROLLBACK').catch(() => { scope.broken = true; });
        throw scope.failure ?? error;
      } finally { scope.inTransaction = false; }
    });
  }
  async withSessionLock<T>(key: string, work: (sql: SqlExecutor, signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.inSession(async (scope) => {
      if (scope.inTransaction) throw new DomainError('conflict', 'Acquire session locks outside database transactions');
      if (scope.locks.has(key)) return work(scope.sql, scope.controller.signal);
      await scope.sql.query("SET lock_timeout = '10s'");
      let locked = false;
      try {
        await scope.sql.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key]);
        locked = true; scope.locks.add(key);
        return await work(scope.sql, scope.controller.signal);
      } finally {
        scope.locks.delete(key);
        if (!scope.failure && scope.active) {
          try {
            if (locked) await scope.sql.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]);
            await scope.sql.query('RESET lock_timeout');
          } catch { scope.broken = true; throw sessionLost(); }
        }
      }
    });
  }
  /** Compatibility alias for platform bootstrap; callback never receives a raw releasable client. */
  async withLock<T>(key: string, work: (sql: SqlExecutor) => Promise<T>): Promise<T> {
    return this.withSessionLock(key, work);
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
