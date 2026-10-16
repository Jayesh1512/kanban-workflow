import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database } from '../shared/ports.js';
import { defaultMigrationDirectory } from './database.js';

/** Cache the immutable artifact manifest once; each check reads only current SQL state. */
export async function createMigrationGate(db: Database, directory = defaultMigrationDirectory): Promise<() => Promise<'ready' | 'pending' | 'drift'>> {
  const names = (await readdir(directory)).filter((name) => /^\d[\w.-]*\.sql$/.test(name));
  const expected = new Map(await Promise.all(names.map(async (name) => [name, createHash('sha256').update(await readFile(join(directory, name))).digest('hex')] as const)));
  if (!expected.size) throw new Error('Migration manifest is empty');
  return () => db.transaction(async (tx) => {
    const lock = (await tx.query<{ ready: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended('antseed:migrations',0)) AS ready")).rows[0];
    if (!lock?.ready) return 'pending';
    if (!(await tx.query<{ name: string | null }>("SELECT to_regclass('schema_migrations')::text AS name")).rows[0]?.name) return 'pending';
    const rows = (await tx.query<{ version: string; checksum: string }>('SELECT version,checksum FROM schema_migrations')).rows;
    if (new Set(rows.map((row) => row.version)).size !== rows.length || rows.some((row) => expected.get(row.version) !== row.checksum)) return 'drift';
    return rows.length === expected.size ? 'ready' : 'pending';
  });
}
