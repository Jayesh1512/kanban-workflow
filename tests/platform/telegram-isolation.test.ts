import { tl } from '@mtcute/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MtcuteAdapter } from '../../src/telegram/adapter.js';
import { DurableControlBus } from '../../src/telegram/control.js';
import { TelegramSync } from '../../src/telegram/sync.js';
import { fixtureMessage, telegramFixture } from './telegram-fixture.js';

const inaccessible = '-10042', healthy = '-10041', controlId = '-10099';
describe('durable per-chat replay isolation (synthetic transport; actual local SQL)', () => {
  let f: Awaited<ReturnType<typeof telegramFixture>>, sync: TelegramSync;
  let failure: Error | null, bad: string, calls: string[];
  let telegram: MtcuteAdapter;
  beforeEach(async () => {
    f = await telegramFixture(); failure = new tl.RpcError(400, 'CHANNEL_PRIVATE'); bad = inaccessible; calls = [];
    for (const id of [inaccessible, healthy]) await f.store.upsertDialog({ id, title: 'Synthetic isolation fixture', kind: 'supergroup', username: null, archived: true });
    await f.db.query('UPDATE telegram_history_requests SET remaining_batches=0');
    telegram = { loginState: async () => ({ state: 'ready' }), status: async () => ({ state: 'ready' }),
      async getHistory(chatId: string) { calls.push(chatId); if (chatId === bad && failure) throw failure; return { messages: [fixtureMessage(1, chatId)], next: null, complete: false }; },
      async replayPage(chatId: string) { calls.push(chatId); if (chatId === bad && failure) throw failure; return []; },
      async recent(chatId: string, ids: number[]) { return ids.map((id) => fixtureMessage(id, chatId)); },
      async *discoverDialogs() {}, subscribe: () => () => {},
    } as unknown as MtcuteAdapter;
    sync = new TelegramSync(f.db, f.store, telegram, new DurableControlBus(f.db, telegram));
  });
  afterEach(async () => { vi.restoreAllMocks(); await sync.stop(); await f.db.close(); });
  const retries = async () => (await f.db.query("SELECT key,value FROM app_settings WHERE key LIKE 'telegram:sync-retry:%' ORDER BY key")).rows;
  const expire = async () => f.db.query("UPDATE app_settings SET value=jsonb_set(value,'{retryAt}',to_jsonb((now()-interval '1 second')::text)) WHERE key LIKE 'telegram:sync-retry:%'");
  it('skips inaccessible head replay across ticks/restarts without advancing coverage, then recovers after backoff', async () => {
    const before = await f.store.getLiveCheckpoint(inaccessible); await sync.tick(); await sync.tick(); await sync.tick();
    expect(calls.filter((id) => id === inaccessible)).toHaveLength(1); expect(calls).toContain(healthy);
    expect(await f.store.getLiveCheckpoint(inaccessible)).toEqual(before); expect((await f.store.getLiveCheckpoint(healthy)).highWaterMessageId).toBe(1);
    expect((await f.db.query('SELECT * FROM messages WHERE chat_id=$1', [healthy])).rowCount).toBe(1);
    expect((await retries())[0]!['value']).toMatchObject({ chatId: inaccessible, phase: 'replay', attempts: 1, error: 'CHANNEL_PRIVATE' }); expect(sync.status()).toMatchObject({ state: 'degraded', code: 'telegram_chat_retry' });
    await sync.stop(); sync = new TelegramSync(f.db, f.store, telegram, new DurableControlBus(f.db, telegram)); await sync.tick(); expect(calls.filter((id) => id === inaccessible)).toHaveLength(1);
    failure = null; await expire(); await sync.tick(); expect((await f.store.getLiveCheckpoint(inaccessible)).highWaterMessageId).toBe(1); expect(await retries()).toEqual([]);
  });
  it('failed forward replay retains an existing successful high-water/date/generation exactly', async () => {
    await f.db.query("UPDATE live_checkpoints SET high_water_message_id=5,reconciled_at='2026-01-01T00:00:00Z' WHERE chat_id=$1", [inaccessible]);
    const before = await f.store.getLiveCheckpoint(inaccessible); await sync.tick(); await sync.tick();
    expect(await f.store.getLiveCheckpoint(inaccessible)).toEqual(before); expect((await f.store.getLiveCheckpoint(healthy)).highWaterMessageId).toBe(1);
  });
  it('inaccessible control replay leaves its cursor unchanged while healthy business and existing inbox replies continue', async () => {
    await f.store.upsertDialog({ id: controlId, title: 'Synthetic controls', kind: 'supergroup', username: null, archived: false });
    await f.db.query("UPDATE chats SET is_control=true,inclusion='excluded' WHERE id=$1", [controlId]); await f.db.query('UPDATE telegram_history_requests SET remaining_batches=0');
    await f.store.ingest({ type: 'message', message: { ...fixtureMessage(7, controlId), replyToId: 6 } }); bad = controlId;
    const bus = new DurableControlBus(f.db, telegram), delivered: number[] = []; bus.subscribe(async (m) => { delivered.push(m.messageId); });
    await sync.stop(); sync = new TelegramSync(f.db, f.store, telegram, bus); await sync.tick(); await sync.tick();
    expect(calls).toContain(healthy); expect(delivered).toEqual([7]); expect((await f.db.query('SELECT * FROM app_settings WHERE key=$1', [`telegram:control-replay:${controlId}`])).rowCount).toBe(0);
    await sync.tick(); expect(calls.filter((id) => id === controlId)).toHaveLength(1); expect((await retries())[0]!['value']).toMatchObject({ chatId: controlId, phase: 'control' });
    failure = null; await expire(); await sync.tick(); await sync.tick(); expect(delivered).toEqual([7, 1]);
    expect((await f.db.query('SELECT * FROM messages WHERE chat_id=$1', [controlId])).rowCount).toBe(0); expect((await f.db.query('SELECT value FROM app_settings WHERE key=$1', [`telegram:control-replay:${controlId}`])).rows[0]!['value']).toBe(1);
  });
  it('isolates bounded history access errors and leaves cursor/count/remaining budget intact', async () => {
    await f.db.query('UPDATE telegram_history_requests SET remaining_batches=2');
    await sync.tick(); const cursor = await f.store.getCursor(inaccessible); expect(cursor).toMatchObject({ nextMessageId: null, importedCount: 0, status: 'error' });
    expect((await f.db.query('SELECT remaining_batches FROM telegram_history_requests WHERE chat_id=$1', [inaccessible])).rows[0]!['remaining_batches']).toBe(2);
    await sync.tick(); expect((await f.store.getCursor(healthy)).importedCount).toBe(1); expect(calls.filter((id) => id === inaccessible)).toHaveLength(2);
  });
  it('repeated access failures use durable capped backoff, then successful recovery clears only that phase', async () => {
    await sync.tick();
    for (let i = 0; i < 5; i++) { await expire(); await sync.tick(); }
    const row = (await retries())[0]!['value'] as { attempts: number; retryAt: string };
    expect(row.attempts).toBe(6); const interval = Date.parse(row.retryAt) - Date.now(); expect(interval).toBeGreaterThan(280_000); expect(interval).toBeLessThanOrEqual(300_000);
  });
  it.each([
    { error: tl.RpcError.fromTl({ errorCode: 420, errorMessage: 'FLOOD_WAIT_45' }), wait: 45_000 },
    { error: new tl.RpcError(401, 'AUTH_KEY_UNREGISTERED'), wait: 10_000 },
    { error: new Error('synthetic network outage'), wait: 10_000 },
  ])('keeps global flood/auth/network errors global with bounded retry and no false coverage: $error', async ({ error, wait }) => {
    failure = error; let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const before = await f.store.getLiveCheckpoint(inaccessible); await expect(sync.tick()).rejects.toBe(error); expect(await retries()).toEqual([]); expect(await f.store.getLiveCheckpoint(inaccessible)).toEqual(before);
    now += wait - 1; await sync.tick(); expect(calls).toEqual([inaccessible]); failure = null; now++; await sync.tick(); expect(calls).toEqual([inaccessible, inaccessible]);
  });
  it('SQL commit failure uses global backoff and cannot masquerade as chat access or advance replay', async () => {
    failure = null; const error = new Error('synthetic database outage'); vi.spyOn(f.store, 'commitReplay').mockRejectedValueOnce(error);
    const before = await f.store.getLiveCheckpoint(inaccessible); await expect(sync.tick()).rejects.toBe(error); await sync.tick();
    expect(calls).toEqual([inaccessible]); expect(await f.store.getLiveCheckpoint(inaccessible)).toEqual(before); expect(await retries()).toEqual([]); expect(sync.status()).toMatchObject({code:'telegram_sync_retry',detail:expect.stringContaining('live replay')});
  });
});
