import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PgDatabase, migrate } from '../../src/platform/database.js';
import type { TelegramPort } from '../../src/shared/ports.js';
import { DurableControlBus } from '../../src/telegram/control.js';
import { TelegramStore } from '../../src/telegram/store.js';
import { fixtureMessage } from './telegram-fixture.js';

const url = process.env['TELEGRAM_TEST_DATABASE_URL'];
describe.skipIf(!url)('M2 actual isolated PostgreSQL (synthetic Telegram events, no authenticated Telegram)', () => {
  let admin: PgDatabase, db: PgDatabase, schema: string, store: TelegramStore, scopedUrl: string;
  beforeEach(async () => {
    admin = new PgDatabase(url!); schema = `telegram_m2_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const connection = new URL(url!); connection.searchParams.set('options', `-c search_path=${schema},public`); scopedUrl = connection.toString();
    db = new PgDatabase(scopedUrl); await migrate(db); store = new TelegramStore(db, { apiId: null, apiHash: null, sessionPath: ':memory:', historyBatchSize: 100, historyMaxBatches: 2 }); await store.bindAccount('123');
  });
  afterEach(async () => { await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); });
  const discover = () => store.upsertDialog({ id: '-10042', title: 'Synthetic PG fixture', kind: 'supergroup', username: null, archived: true });
  it('repeats checksum migration and resumes persisted cursor/account after pool restart', async () => {
    await discover(); const cursor = await store.claimHistory('-10042', 'worker', 30_000);
    await store.commitHistoryBatch('-10042', 0, cursor!.generation, { messages: [fixtureMessage(9)], next: { messageId: 9, date: fixtureMessage(9).sentAt }, complete: false });
    await migrate(db); expect((await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(r=>r.version)).toEqual(['001_initial.sql','202610170001_telegram_operations.sql','202610170002_decision_origins.sql','202610170003_contact_prospects.sql']); await db.close(); db = new PgDatabase(scopedUrl); await migrate(db);
    store = new TelegramStore(db, { apiId: null, apiHash: null, sessionPath: ':memory:', historyBatchSize: 100, historyMaxBatches: 2 });
    expect(await store.getCursor('-10042')).toMatchObject({ nextMessageId: 9, importedCount: 1 }); await expect(store.bindAccount('999')).rejects.toMatchObject({ code: 'conflict' });
  });
  it('serializes concurrent edit/delete/history so scoped and pre-chat tombstones dominate every replay', async () => {
    await discover(); await Promise.all(Array.from({ length: 8 }, (_, i) => Promise.all([
      store.ingest({ type: 'message', message: fixtureMessage(i + 1) }),
      store.ingest({ type: 'delete', chatId: '-10042', messageIds: [i + 1], observedAt: '2026-10-17T02:00:00.000Z' }),
    ])));
    for (let id = 1; id <= 8; id++) await store.ingest({ type: 'edit', message: { ...fixtureMessage(id), editedAt: '2026-10-18T00:00:00.000Z' } });
    expect((await db.query('SELECT * FROM messages WHERE deleted_at IS NULL')).rowCount).toBe(0); expect((await db.query('SELECT * FROM message_tombstones')).rowCount).toBe(8);
    await store.ingest({ type: 'delete', chatId: '-10043', messageIds: [1], observedAt: '2026-10-17T02:00:00.000Z' });
    expect((await db.query('SELECT * FROM chats WHERE id=-10043')).rowCount).toBe(0);
  });
  it('fences same-worker expired history claims and coordinates concurrent inbox consumers through real session locks', async () => {
    await discover(); const old = (await store.claimHistory('-10042', 'same-worker', 30_000))!;
    await db.query("UPDATE history_cursors SET lease_until=now()-interval '1 second'"); const fresh = (await store.claimHistory('-10042', 'same-worker', 30_000))!;
    expect(fresh.generation).toBeGreaterThan(old.generation); await expect(store.commitHistoryBatch('-10042', 0, old.generation, { messages: [fixtureMessage(1)], next: null, complete: true })).rejects.toMatchObject({ code: 'conflict' });
    expect((await db.query('SELECT * FROM messages')).rowCount).toBe(0);
    await db.query("UPDATE chats SET is_control=true,inclusion='excluded' WHERE id=-10042"); await store.ingest({ type: 'message', message: fixtureMessage(3) });
    const telegram = { status: async () => ({ state: 'ready' }) } as unknown as TelegramPort;
    const a = new DurableControlBus(db, telegram), b = new DurableControlBus(db, telegram); let calls = 0;
    a.subscribe(async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 30)); }); b.subscribe(async () => { calls++; });
    await Promise.all([a.tick(), b.tick()]); expect(calls).toBe(1); expect((await db.query('SELECT state FROM control_inbox')).rows[0]!['state']).toBe('done');
  });
});
