import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { Db, SqlValue } from '../contracts/index.ts';

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new DatabaseSync(path);
  let depth = 0;
  sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;');
  sqlite.exec('CREATE TABLE IF NOT EXISTS schema_migration (name TEXT PRIMARY KEY) STRICT');
  const migrations = fileURLToPath(new URL('./migrations/', import.meta.url));
  for (const name of readdirSync(migrations)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    if (sqlite.prepare('SELECT name FROM schema_migration WHERE name=?').get(name)) continue;
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      sqlite.exec(readFileSync(`${migrations}/${name}`, 'utf8'));
      sqlite.prepare('INSERT INTO schema_migration(name) VALUES (?)').run(name);
      sqlite.exec('COMMIT');
    } catch (error) {
      sqlite.exec('ROLLBACK');
      sqlite.close();
      throw error;
    }
  }
  return {
    get<T>(sql: string, ...params: SqlValue[]): T | undefined {
      return sqlite.prepare(sql).get(...params) as T | undefined;
    },
    all<T>(sql: string, ...params: SqlValue[]): T[] {
      return sqlite.prepare(sql).all(...params) as T[];
    },
    run(sql: string, ...params: SqlValue[]) {
      if (/^\s*(INSERT|UPDATE|DELETE)\s+(INTO\s+)?action_log\b/i.test(sql) && depth === 0) {
        throw new Error('action log writes require Db.tx');
      }
      const result = sqlite.prepare(sql).run(...params);
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
    },
    tx<T>(fn: () => T): T {
      if (depth > 0) return fn();
      sqlite.exec('BEGIN IMMEDIATE');
      depth++;
      try {
        const result = fn();
        if (result instanceof Promise) throw new Error('Db.tx requires a synchronous callback');
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      } finally {
        depth--;
      }
    },
    close() {
      sqlite.close();
    },
  };
}
