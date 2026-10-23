import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PgDatabase } from '../../src/platform/database.js';
import type { TelegramMessageInput } from '../../src/shared/ports.js';
import { telegramFixture } from './telegram-fixture.js';
import { TelegramStore } from '../../src/telegram/store.js';

describe('synthetic Telegram events against actual SQL storage (PGlite)', () => {
  let engine: PGlite, db: PgDatabase, store: TelegramStore;
  beforeEach(async () => {
    // These storage/source-fencing cases start with admitted synthetic chats.
    const fixture = await telegramFixture();
    engine = fixture.engine; db = fixture.db; store = fixture.store;
  });
  afterEach(async () => { await engine.close(); });
  const dialog = (id = '-10042', kind: 'supergroup' | 'user' = 'supergroup') => ({ id, kind, title: 'Synthetic fixture chat', username: null, archived: true });
  const message = (id: number, chatId = '-10042', text = 'We are testing the integration'): TelegramMessageInput => {
    const observedAt = '2026-10-17T00:00:00.000Z';
    return { chatId, id, senderId: '456', sentAt: observedAt, editedAt: null, text, replyToId: null, sourceUrl: null,
      sender: { id: '456', kind: 'user', names: ['Synthetic person'], usernames: ['fixture'], visiblePhones: [], visibleEmails: [], observedAt },
      peer: { id: chatId, kind: 'channel', names: ['Synthetic fixture chat'], usernames: [], visiblePhones: [], visibleEmails: [], observedAt },
      forward: { isForwarded: false, sourceKind: 'own', originPeer: null, originName: null, originDate: null, originMessageId: null } };
  };
  it('binds one real self identity; mismatch cannot silently mix datasets', async () => {
    await store.bindAccount('123'); await expect(store.bindAccount('999')).rejects.toThrow('different dataset account');
    expect((await db.query('SELECT self_user_id FROM telegram_account')).rows.map((r) => String(r['self_user_id']))).toEqual(['123']);
  });
  it('preserves admitted archived chats; preserves exclusions and creates no job/content after exclusion', async () => {
    const chat = await store.upsertDialog(dialog()); expect(chat.archived).toBe(true); expect(chat.inclusion).toBe('included');
    const excluded = await store.setInclusion({ chatId: chat.id, expectedPolicyVersion: 0, inclusion: 'excluded', idempotencyKey: 'exclude-one' });
    expect(excluded.policyVersion).toBe(1);
    expect((await store.upsertDialog({ ...dialog(), title: 'Renamed visible chat' })).inclusion).toBe('excluded');
    await store.ingest({ type: 'message', message: message(1) });
    expect((await db.query('SELECT * FROM messages')).rowCount).toBe(0); expect((await db.query('SELECT * FROM analysis_jobs')).rowCount).toBe(0);
    expect(await store.setInclusion({ chatId: chat.id, expectedPolicyVersion: 0, inclusion: 'excluded', idempotencyKey: 'exclude-one' })).toEqual(excluded);
    await expect(store.setInclusion({ chatId: chat.id, expectedPolicyVersion: 1, inclusion: 'included', idempotencyKey: 'exclude-one' })).rejects.toThrow('different request');
  });
  it('atomically dedupes messages and versioned analysis snapshots; ignores older history and invalidates edit evidence', async () => {
    await store.upsertDialog(dialog()); const m = message(1);
    await store.ingest({ type: 'message', message: m });
    await store.ingest({ type: 'message', message: { ...m, sender: { ...m.sender, observedAt: '2026-10-18T00:00:00.000Z' } } });
    expect((await db.query('SELECT * FROM messages')).rowCount).toBe(1); expect((await db.query('SELECT * FROM analysis_jobs')).rowCount).toBe(1);
    expect((await db.query('SELECT message_version FROM analysis_job_messages')).rows[0]?.['message_version']).toBe(1);
    await db.query("INSERT INTO evidence(id,chat_id,message_id,message_version,excerpt,observed_at) VALUES($1,$2,1,1,'fixture',now())", [randomUUID(), '-10042']);
    await store.ingest({ type: 'edit', message: { ...m, editedAt: '2026-10-17T01:00:00.000Z', text: 'Actually blocked' } });
    await store.ingest({ type: 'message', message: m });
    const row = (await db.query('SELECT * FROM messages')).rows[0]!;
    expect(row['version']).toBe(2); expect(row['text']).toBe('Actually blocked'); expect(row['sender_snapshot']).toEqual(m.sender);
    expect((await db.query('SELECT invalidated_at FROM evidence')).rows[0]?.['invalidated_at']).not.toBeNull();
    expect((await db.query("SELECT * FROM analysis_jobs WHERE status='cancelled'")).rowCount).toBe(1);
    expect((await db.query("SELECT * FROM analysis_jobs WHERE status='pending'")).rowCount).toBe(1);
  });
  it.each(['sentAt', 'editedAt', 'forward.originDate'] as const)('dedupes equivalent RFC3339 spellings for %s without invalidating evidence or enqueuing another job', async (field) => {
    await store.upsertDialog(dialog());
    const m = { ...message(1), sentAt: '2026-10-17T09:00:00.000Z', editedAt: '2026-10-17T10:00:00.000Z',
      forward: { ...message(1).forward, isForwarded: true, sourceKind: 'forwarded' as const, originDate: '2026-10-17T08:00:00.000Z' } };
    await store.ingest({ type: 'message', message: m });
    await db.query("INSERT INTO evidence(id,chat_id,message_id,message_version,excerpt,observed_at) VALUES($1,$2,1,1,'fixture',now())", [randomUUID(), m.chatId]);
    const variants = field === 'sentAt' ? ['2026-10-17T09:00:00Z', '2026-10-17T14:30:00+05:30']
      : field === 'editedAt' ? ['2026-10-17T10:00:00Z', '2026-10-17T15:30:00+05:30'] : ['2026-10-17T08:00:00Z', '2026-10-17T13:30:00+05:30'];
    for (const value of variants) {
      const replay = field === 'forward.originDate' ? { ...m, forward: { ...m.forward, originDate: value } } : { ...m, [field]: value };
      await store.ingest({ type: 'message', message: replay });
    }
    // Existing JSONB may retain the old noncanonical forward-date spelling.
    if (field === 'forward.originDate') {
      await db.query('UPDATE messages SET forward_metadata=$1 WHERE chat_id=$2 AND id=1', [JSON.stringify({ ...m.forward, originDate: variants[1] }), m.chatId]);
      await store.ingest({ type: 'message', message: m });
    }
    expect((await db.query('SELECT version FROM messages')).rows[0]?.['version']).toBe(1);
    expect((await db.query('SELECT * FROM analysis_jobs')).rowCount).toBe(1);
    expect((await db.query('SELECT invalidated_at FROM evidence')).rows[0]?.['invalidated_at']).toBeNull();
    await store.ingest({ type: 'edit', message: { ...m, editedAt: '2026-10-17T10:00:00.001Z' } });
    expect((await db.query('SELECT version FROM messages')).rows[0]?.['version']).toBe(2);
    expect((await db.query('SELECT * FROM analysis_jobs')).rowCount).toBe(2);
    expect((await db.query('SELECT invalidated_at FROM evidence')).rows[0]?.['invalidated_at']).not.toBeNull();
  });
  it('persists scoped deletion before chat discovery and never resurrects it on later history', async () => {
    await store.ingest({ type: 'delete', chatId: '-10042', messageIds: [7], observedAt: '2026-10-17T02:00:00.000Z' });
    expect((await db.query('SELECT * FROM chats')).rowCount).toBe(0);
    await store.upsertDialog(dialog()); await store.ingest({ type: 'message', message: message(7) });
    const row = (await db.query('SELECT * FROM messages')).rows[0]!;
    expect(row['deleted_at']).not.toBeNull(); expect(row['text']).toBe('');
    await store.ingest({ type: 'edit', message: { ...message(7), text: 'must not resurrect', editedAt: '2026-10-18T00:00:00.000Z' } });
    expect((await db.query('SELECT version FROM messages')).rows[0]?.['version']).toBe(1);
    expect((await db.query('SELECT * FROM analysis_jobs')).rowCount).toBe(0);
  });
  it('null-scope deletes affect common mailbox only, including before-message tombstones', async () => {
    await store.upsertDialog(dialog()); await store.upsertDialog(dialog('42', 'user'));
    await store.ingest({ type: 'delete', chatId: null, messageIds: [8], observedAt: '2026-10-17T02:00:00.000Z' });
    await store.ingest({ type: 'message', message: message(8, '42') }); await store.ingest({ type: 'message', message: message(8) });
    const rows = (await db.query('SELECT chat_id,deleted_at FROM messages ORDER BY chat_id')).rows;
    expect(rows.find((r) => String(r['chat_id']) === '-10042')?.['deleted_at']).toBeNull();
    expect(rows.find((r) => String(r['chat_id']) === '42')?.['deleted_at']).not.toBeNull();
  });
  it('fences history claims by generation/lease and commits cursor/messages/jobs together', async () => {
    const chat = await store.upsertDialog(dialog());
    const claim = await store.claimHistory(chat.id, 'worker', 10_000); expect(claim).not.toBeNull();
    expect(await store.claimHistory(chat.id, 'same-worker', 10_000)).toBeNull();
    const batch = { messages: [message(10)], next: { messageId: 10, date: '2026-10-17T00:00:00.000Z' }, complete: false };
    await expect(store.commitHistoryBatch(chat.id, 0, claim!.generation - 1, batch)).rejects.toThrow('superseded');
    expect((await db.query('SELECT * FROM messages')).rowCount).toBe(0);
    const committed = await store.commitHistoryBatch(chat.id, 0, claim!.generation, batch);
    expect(committed.importedCount).toBe(1); expect(committed.generation).toBe(claim!.generation + 1);
    await expect(store.commitHistoryBatch(chat.id, 0, claim!.generation, batch)).rejects.toThrow('superseded');
    const next = await store.claimHistory(chat.id, 'worker', 10_000);
    await store.setInclusion({ chatId: chat.id, expectedPolicyVersion: 0, inclusion: 'excluded', idempotencyKey: 'exclude-during-import' });
    await expect(store.commitHistoryBatch(chat.id, 0, next!.generation, { ...batch, messages: [message(9)] })).rejects.toThrow('policy changed');
    expect((await db.query('SELECT * FROM messages')).rowCount).toBe(1);
  });
  it('separates live coverage from backfill; replay CAS rejects gaps/stale callbacks', async () => {
    await store.upsertDialog(dialog()); const initial = await store.getLiveCheckpoint('-10042');
    await expect(store.commitReplay({ chatId: '-10042', expectedPolicyVersion: 0, expectedGeneration: initial.generation, messages: [message(20)], highWaterMessageId: 21 })).rejects.toThrow('coverage');
    const next = await store.commitReplay({ chatId: '-10042', expectedPolicyVersion: 0, expectedGeneration: initial.generation, messages: [message(20)], highWaterMessageId: 20 });
    expect(next.replayRequired).toBe(true); expect((await store.getCursor('-10042')).nextMessageId).toBeNull();
    await expect(store.commitReplay({ chatId: '-10042', expectedPolicyVersion: 0, expectedGeneration: initial.generation, messages: [], highWaterMessageId: 20 })).rejects.toThrow('superseded');
    expect((await store.commitReplay({ chatId: '-10042', expectedPolicyVersion: 0, expectedGeneration: next.generation, messages: [], highWaterMessageId: 20 })).replayRequired).toBe(false);
  });
  it('routes excluded control replies to durable inbox before business policy, with duplicate delivery deduped', async () => {
    await store.upsertDialog(dialog());
    await db.query("UPDATE chats SET inclusion='excluded',is_control=true WHERE id=-10042");
    const m = { ...message(30), replyToId: 29, text: 'approve' };
    await store.ingest({ type: 'message', message: m }); await store.ingest({ type: 'message', message: m });
    expect((await db.query('SELECT * FROM control_inbox')).rowCount).toBe(1);
    expect((await db.query('SELECT * FROM messages')).rowCount).toBe(0); expect((await db.query('SELECT * FROM analysis_jobs')).rowCount).toBe(0);
  });
});
