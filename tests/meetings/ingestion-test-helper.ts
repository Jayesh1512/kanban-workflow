import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { QueryResult, QueryResultRow } from 'pg';
import type { Database, SqlExecutor } from '../../src/shared/ports.js';
import type { MeetingArchive } from '../../src/meetings/domain.js';

export async function ingestionDatabase(): Promise<Database> {
  const engine = new PGlite();
  await engine.exec(await readFile(new URL('../../db/migrations/202610260004_meeting_ingestion.sql', import.meta.url), 'utf8'));
  await engine.exec('CREATE TABLE test_ingestion(recording_id bigint PRIMARY KEY,payload jsonb NOT NULL)');
  const executor: SqlExecutor = { async query<R extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<R>> {
    const result = await engine.query<R>(sql, values); return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length, fields: [], command: '', oid: 0 };
  } };
  let tail: Promise<unknown> = Promise.resolve();
  return { ...executor, transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const next = tail.then(async () => { await engine.exec('BEGIN'); try { const result = await work(executor); await engine.exec('COMMIT'); return result; } catch (error) { await engine.exec('ROLLBACK'); throw error; } });
    tail = next.catch(() => {}); return next;
  }, async withSessionLock() { throw new Error('PGlite does not prove session locking'); }, async close() { await tail; await engine.close(); } };
}
export function ingestionArchive(db: Database): MeetingArchive {
  const unavailable = async (): Promise<never> => { throw new Error('Not used in ingestion tests'); };
  return { async ingestPage(items, _meta, tx = db) {
    for (const item of items) await tx.query('INSERT INTO test_ingestion(recording_id,payload) VALUES($1,$2) ON CONFLICT(recording_id) DO UPDATE SET payload=excluded.payload', [item.recording_id, JSON.stringify(item)]);
    return { imported: items.length, unchanged: 0 };
  }, list: unavailable, get: unavailable, transcript: unavailable, customers: unavailable, setCustomers: unavailable };
}
export async function fathomHttp(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  return { baseUrl: `http://127.0.0.1:${address.port}/external/v1/`, async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
