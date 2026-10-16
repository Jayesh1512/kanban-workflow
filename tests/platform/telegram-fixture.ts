import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { QueryResult, QueryResultRow } from 'pg';
import type { SqlExecutor, TelegramMessageInput } from '../../src/shared/ports.js';
import type { PgDatabase } from '../../src/platform/database.js';
import { TelegramStore } from '../../src/telegram/store.js';
export async function telegramFixture() {
  const engine = new PGlite();
  await engine.exec(await readFile(new URL('../../db/migrations/001_initial.sql', import.meta.url), 'utf8'));
  await engine.exec(await readFile(new URL('../../db/migrations/202610170001_telegram_operations.sql', import.meta.url), 'utf8'));
  const wrap = (client: Pick<PGlite, 'query'>): SqlExecutor => ({ async query<R extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>> {
    const r = await client.query<R>(text, values); return { rows: r.rows, rowCount: r.rows.length || r.affectedRows || 0, command: '', fields: [], oid: 0 };
  } });
  const executor = wrap(engine);
  // Test-only serialized lock seam; production lock/socket behavior is exercised
  // separately against actual PostgreSQL, not claimed by this fixture.
  const db = { ...executor, transaction: async <T>(fn: (tx: SqlExecutor) => Promise<T>) => engine.transaction((tx) => fn(wrap(tx))),
    withSessionLock: async <T>(_key: string, fn: (tx: SqlExecutor, signal: AbortSignal) => Promise<T>) => fn(executor, new AbortController().signal), close: () => engine.close() } as unknown as PgDatabase;
  const store = new TelegramStore(db, { apiId: null, apiHash: null, sessionPath: ':memory:', historyBatchSize: 2, historyMaxBatches: 2 });
  await store.bindAccount('123');
  return { engine, db, store };
}
export const fixtureMessage = (id: number, chatId = '-10042', text = 'Synthetic operational fixture'): TelegramMessageInput => {
  const observedAt = '2026-10-17T00:00:00.000Z';
  return { chatId, id, senderId: '123', sentAt: observedAt, editedAt: null, text, replyToId: null, sourceUrl: null,
    sender: { id: '123', kind: 'user', names: ['Synthetic self'], usernames: [], visiblePhones: [], visibleEmails: [], observedAt },
    peer: { id: chatId, kind: 'channel', names: ['Fixture'], usernames: [], visiblePhones: [], visibleEmails: [], observedAt },
    forward: { isForwarded: false, sourceKind: 'own', originPeer: null, originName: null, originDate: null, originMessageId: null } };
};
