import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Database, SqlExecutor } from '../../src/shared/ports.js';
import { createMigrationGate } from '../../src/platform/migration-gate.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-ledger-gate-')); directories.push(directory);
  const body = '-- immutable synthetic migration\n', checksum = createHash('sha256').update(body).digest('hex');
  await writeFile(join(directory, '001_probe.sql'), body); await writeFile(join(directory, 'README.md'), 'Not a migration');
  const state = { lock: true, exists: true, rows: [{ version: '001_probe.sql', checksum }], failure: null as Error | null };
  const queries: string[] = [];
  const tx: SqlExecutor = { async query(sql) {
    queries.push(sql); if (state.failure) throw state.failure;
    const rows = sql.includes('pg_try_advisory_xact_lock') ? [{ ready: state.lock }] : sql.includes('to_regclass') ? [{ name: state.exists ? 'schema_migrations' : null }] : state.rows;
    return { rows, rowCount: rows.length } as never;
  } };
  const db = { transaction: async <T>(work: (executor: SqlExecutor) => Promise<T>) => work(tx) } as Database;
  return { directory, state, queries, gate: await createMigrationGate(db, directory) };
}
describe('immutable expected manifest with current read-only ledger gate', () => {
  it('constructs with no SQL and rechecks exact current ledger each call using only SELECTs', async () => {
    const f = await fixture(); expect(f.queries).toEqual([]); expect(await f.gate()).toBe('ready');
    f.state.rows[0]!.checksum = '0'.repeat(64); expect(await f.gate()).toBe('drift');
    expect(f.queries.every((sql) => sql.startsWith('SELECT '))).toBe(true);
  });
  it.each(['lock', 'table', 'row'] as const)('reports pending for unavailable %s without repair', async (missing) => {
    const f = await fixture(); if (missing === 'lock') f.state.lock = false; else if (missing === 'table') f.state.exists = false; else f.state.rows = [];
    expect(await f.gate()).toBe('pending'); expect(f.queries.every((sql) => sql.startsWith('SELECT '))).toBe(true);
  });
  it.each(['unknown', 'duplicate'] as const)('rejects %s ledger entries', async (kind) => {
    const f = await fixture(); f.state.rows.push(kind === 'duplicate' ? { ...f.state.rows[0]! } : { version: '999_external.sql', checksum: 'f'.repeat(64) });
    expect(await f.gate()).toBe('drift');
  });
  it('retains the factory manifest instead of accepting a changed disk file on a request', async () => {
    const f = await fixture(); const changed = '-- changed after module construction\n'; await writeFile(join(f.directory, '001_probe.sql'), changed);
    expect(await f.gate()).toBe('ready'); f.state.rows[0]!.checksum = createHash('sha256').update(changed).digest('hex'); expect(await f.gate()).toBe('drift');
  });
  it('leaves storage error handling to the owning sanitized readiness boundary', async () => {
    const f = await fixture(), error = new Error('Synthetic SQL outage'); f.state.failure = error; await expect(f.gate()).rejects.toBe(error);
  });
});
