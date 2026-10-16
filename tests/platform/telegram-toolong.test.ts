import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chat, DeleteMessageUpdate, Long, User } from '@mtcute/node';
import type { TelegramClient } from '@mtcute/node';
import { expect, it, vi } from 'vitest';
import { MtcuteAdapter } from '../../src/telegram/adapter.js';
import { telegramFixture } from './telegram-fixture.js';

it('marks native raw TooLong channel IDs only; already-marked deletes keep channel scope (synthetic transport, actual SQL)', async () => {
  const f = await telegramFixture(), directory = await mkdtemp(join(tmpdir(), 'antseed-toolong-')), path = join(directory, 'client.session'); await writeFile(path, 'synthetic session marker');
  const channel = new Chat({ _: 'channel', id: 42, title: 'Fixture channel', accessHash: Long.ZERO, photo: { _: 'chatPhotoEmpty' }, date: 1 });
  const self = new User({ _: 'user', id: 123, firstName: 'Synthetic', self: true });
  await f.store.upsertDialog({ id: String(channel.id), kind: 'channel', title: channel.title, username: null, archived: false });
  await f.store.upsertDialog({ id: '42', kind: 'user', title: 'Different user with same raw ID', username: null, archived: false });
  let tooLong!: (id: number) => void, deleted!: (update: DeleteMessageUpdate) => void;
  const adapter = new MtcuteAdapter({ apiId: 1, apiHash: 'synthetic', sessionPath: path, historyBatchSize: 100, historyMaxBatches: 1 }, f.store, (_mode, onTooLong) => {
    tooLong = onTooLong; const emitter = { add(_fn: unknown) {} };
    return { async prepare() {}, async destroy() {}, async stopUpdatesLoop() {}, async getMe() { return self; }, async *iterDialogs() {}, async notifyLoggedIn() {},
      onNewMessage: emitter, onEditMessage: emitter, onDeleteMessage: { add(fn: typeof deleted) { deleted = fn; } }, onConnectionState: emitter, onError: emitter } as unknown as TelegramClient;
  });
  adapter.subscribe((event) => f.store.ingest(event));
  try {
    await adapter.start(); await vi.waitFor(async () => { expect((await f.store.getLiveCheckpoint('42')).generation).toBeGreaterThan(0); });
    await f.db.query('UPDATE live_checkpoints SET replay_required=false,generation=0');
    tooLong(42);
    await vi.waitFor(async () => { expect(await f.store.getLiveCheckpoint(String(channel.id))).toMatchObject({ replayRequired: true, generation: 1 }); });
    expect(await f.store.getLiveCheckpoint('42')).toMatchObject({ replayRequired: false, generation: 0 });
    const update = new DeleteMessageUpdate({ _: 'updateDeleteChannelMessages', channelId: 42, messages: [7], pts: 1, ptsCount: 1 }); expect(String(update.channelId)).toBe(String(channel.id)); deleted(update);
    await vi.waitFor(async () => { expect((await f.db.query('SELECT chat_id,message_id FROM message_tombstones')).rows.map((r) => ({ chatId: String(r['chat_id']), id: r['message_id'] }))).toEqual([{ chatId: String(channel.id), id: 7 }]); });
  } finally { await adapter.stop(); await f.db.close(); await rm(directory, { recursive: true, force: true }); }
});
