import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HistoryCursor } from '../../src/shared/domain.js';
import type { MtcuteAdapter } from '../../src/telegram/adapter.js';
import { DurableControlBus } from '../../src/telegram/control.js';
import { TelegramSync } from '../../src/telegram/sync.js';
import { fixtureMessage, telegramFixture } from './telegram-fixture.js';

describe('bounded synchronization using synthetic Telegram pages and real SQL engine', () => {
  let f: Awaited<ReturnType<typeof telegramFixture>>;
  beforeEach(async () => { f = await telegramFixture(); await f.store.upsertDialog({ id: '-10042', title: 'Fixture', kind: 'supergroup', username: null, archived: true }); });
  afterEach(async () => { await f.db.close(); });
  function adapter(getHistory: (chatId: string, cursor: HistoryCursor) => Promise<{ messages: ReturnType<typeof fixtureMessage>[]; next: { messageId: number; date: string } | null; complete: boolean }>, replayPage = async (_chatId: string, _after: number | null) => [] as ReturnType<typeof fixtureMessage>[]) {
    return { loginState: async () => ({ state: 'ready' }), status: async () => ({ state: 'ready' }), getHistory, replayPage, recent: async (_chatId: string, ids: number[]) => ids.map((id) => fixtureMessage(id)), subscribe: () => () => {}, discoverDialogs: async function* () {} } as unknown as MtcuteAdapter;
  }
  it('persists bounded backfill independently from forward coverage and resumes with new worker instance', async () => {
    let historyCalls = 0;
    const tg = adapter(async (_id, cursor) => {
      historyCalls++; const ids = cursor.nextMessageId === null ? [3, 2] : [1];
      return { messages: ids.map((id) => fixtureMessage(id)), next: { messageId: ids.at(-1)!, date: fixtureMessage(1).sentAt }, complete: false };
    }, async (_id, after) => after === 3 ? [fixtureMessage(4)] : []);
    const control = new DurableControlBus(f.db, tg), sync = new TelegramSync(f.db, f.store, tg, control);
    await sync.tick(); await sync.tick(); await sync.tick();
    expect((await f.store.getCursor('-10042'))).toMatchObject({ nextMessageId: 1, status: 'paused', importedCount: 3 });
    expect(await f.store.getLiveCheckpoint('-10042')).toMatchObject({ highWaterMessageId: 4, replayRequired: false }); expect((await f.db.query('SELECT * FROM messages')).rowCount).toBe(4);
    await sync.stop(); const before = historyCalls;
    const resumed = new TelegramSync(f.db, f.store, tg, control); await resumed.tick(); expect(historyCalls).toBe(before); await resumed.stop();
  });
  it('exclusion during a remote history request fences its result and creates no messages/jobs', async () => {
    const tg = adapter(async () => { await f.store.setInclusion({ chatId: '-10042', expectedPolicyVersion: 0, inclusion: 'excluded', idempotencyKey: 'exclude-in-flight' }); return { messages: [fixtureMessage(1)], next: null, complete: false }; });
    const sync = new TelegramSync(f.db, f.store, tg, new DurableControlBus(f.db, tg)); await sync.tick();
    expect((await f.db.query('SELECT * FROM messages')).rowCount).toBe(0); expect((await f.db.query('SELECT * FROM analysis_jobs')).rowCount).toBe(0); expect((await f.store.getCursor('-10042')).status).toBe('paused'); await sync.stop();
  });
  it('periodic reconciliation converts explicit missing-message results to scoped tombstones and persists edits', async () => {
    await f.store.ingest({ type: 'message', message: fixtureMessage(1) }); await f.store.ingest({ type: 'message', message: fixtureMessage(2) });
    const tg = adapter(async () => ({ messages: [], next: null, complete: true }));
    tg.recent = async (_chatId, ids) => ids.map((id) => id === 1 ? null : { ...fixtureMessage(id), text: 'Edited fixture', editedAt: '2026-10-17T01:00:00.000Z' });
    const sync = new TelegramSync(f.db, f.store, tg, new DurableControlBus(f.db, tg)); await sync.tick();
    const rows = (await f.db.query('SELECT id,text,deleted_at FROM messages ORDER BY id')).rows;
    expect(rows[0]!['deleted_at']).not.toBeNull(); expect(rows[1]!['text']).toBe('Edited fixture'); expect((await f.db.query('SELECT * FROM message_tombstones')).rowCount).toBe(1); await sync.stop();
  });
  it('replays operational outgoing replies despite control exclusion using independent durable coverage', async () => {
    await f.db.query("UPDATE chats SET is_control=true,inclusion='excluded' WHERE id=-10042");
    const tg = adapter(async () => ({ messages: [{ ...fixtureMessage(8), replyToId: 7 }], next: null, complete: false }));
    const bus = new DurableControlBus(f.db, tg), delivered: number[] = []; bus.subscribe(async (m) => { delivered.push(m.messageId); });
    const sync = new TelegramSync(f.db, f.store, tg, bus); await sync.tick(); await sync.tick();
    expect(delivered).toEqual([8]); expect((await f.db.query('SELECT * FROM messages')).rowCount).toBe(0); expect((await f.db.query('SELECT * FROM analysis_jobs')).rowCount).toBe(0);
    expect((await f.db.query("SELECT value FROM app_settings WHERE key LIKE 'telegram:control-replay:%'")).rows[0]!['value']).toBe(8); await sync.stop();
  });
});
