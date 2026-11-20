import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { QueryResult, QueryResultRow } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import type { Database, ProviderResult, TelegramMessageInput, TelegramPort } from '../../src/shared/ports.js';
import type { ReplyAnalyzeInput, ReplyAnalyzer, ReplyDecision } from '../../src/reply/analyzer.js';
import { ReplyAgent } from '../../src/reply/agent.js';

const migration = (name: string) => new URL(`../../db/migrations/${name}`, import.meta.url);

async function fixture() {
  const engine = new PGlite();
  for (const name of ['001_initial.sql', '202610170001_telegram_operations.sql', '202610230002_automatic_conversation_scope.sql', '202611200005_reply_agent.sql'])
    await engine.exec(await readFile(migration(name), 'utf8'));
  const executor = { async query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>> {
    const result = await engine.query<R>(text, values);
    return { rows: result.rows, rowCount: result.rows.length || result.affectedRows || 0, fields: [], command: '', oid: 0 };
  } };
  const db = { ...executor, transaction: async <T>(work: (tx: typeof executor) => Promise<T>) => engine.transaction((tx) => work({ async query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
    const result = await tx.query<R>(text, values); return { rows: result.rows, rowCount: result.rows.length || result.affectedRows || 0, fields: [], command: '', oid: 0 };
  } })), close: () => engine.close() } as unknown as Database;
  await db.query("INSERT INTO telegram_account(self_user_id) VALUES(99)");
  await db.query("INSERT INTO chats(id,kind,title,inclusion) VALUES(-1001,'supergroup','Founders Group','undecided')");
  await db.query("INSERT INTO chats(id,kind,title,inclusion) VALUES(-1002,'user','Direct message','undecided')");
  await db.query("INSERT INTO telegram_conversation_starts(chat_id,latest_message_at) VALUES(-1001,'2026-11-20T10:00:00Z')");
  return { engine, db };
}

const message = (id: number, text: string, options: { at?: string; self?: boolean } = {}): TelegramMessageInput => {
  const sentAt = options.at ?? `2026-11-20T10:${String(id % 60).padStart(2, '0')}:00.000Z`;
  const senderId = options.self ? '99' : String(500 + id);
  return { chatId: '-1001', id, senderId, sentAt, editedAt: null, text, replyToId: null, sourceUrl: null,
    sender: { id: senderId, kind: 'user', names: [options.self ? 'Owner' : `Member ${id}`], usernames: [], visiblePhones: [], visibleEmails: [], observedAt: sentAt },
    peer: { id: '-1001', kind: 'chat', names: ['Founders Group'], usernames: [], visiblePhones: [], visibleEmails: [], observedAt: sentAt },
    forward: { isForwarded: false, sourceKind: 'own', originPeer: null, originName: null, originDate: null, originMessageId: null } };
};

const provenance = { provider: 'openai' as const, model: 'test-model', requestId: null, schemaVersion: 'reply-suggestion.v1', completedAt: '2026-11-20T10:00:00.000Z', usage: {} };
const decision = (value: Partial<ReplyDecision>): ProviderResult<ReplyDecision> => ({ ok: true, value: {
  relevant: true, addressedTo: 'Ravi', urgency: 'today', reason: 'Ravi must confirm the delivery date', suggestedText: 'Yes, Friday works. I will confirm the final count by Thursday.', confidence: 0.8, ...value,
}, provenance });

function analyzer(result: ProviderResult<ReplyDecision>, seen: ReplyAnalyzeInput[] = []): ReplyAnalyzer {
  return { status: async () => ({ state: 'ready', code: null, detail: null, checkedAt: '2026-11-20T10:00:00.000Z' }),
    async analyze(input) { seen.push(input); return result; } };
}
function telegram(messages: TelegramMessageInput[]) {
  const sent: Array<{ chatId: string; text: string; randomId: string }> = [];
  const port: TelegramPort = {
    status: async () => ({ state: 'ready', code: null, detail: null, checkedAt: '2026-11-20T10:00:00.000Z' }),
    loginState: async () => ({ state: 'ready', detail: null }),
    submitLogin: async () => ({ state: 'ready', detail: null }),
    authorizedSelf: async () => '99',
    discoverDialogs: async function* () { /* not used by the agent */ },
    getHistory: async () => ({ messages: [...messages].sort((a, b) => b.id - a.id), next: null, complete: true }),
    subscribe: () => () => {},
    configureControlChat: async () => { throw new Error('unused'); },
    reconcileControlSetup: async () => { throw new Error('unused'); },
    sendControlMessage: async () => { throw new Error('unused'); },
    sendText: async (input) => { sent.push(input); return { messageId: 700 }; },
    start: async () => {}, stop: async () => {},
  };
  return { port, sent };
}

const options = { intervalMs: 3_600_000, maxChats: 25, contextMessages: 15, windowMinutes: 60, ownerNames: ['Ravi', 'Ravikant'], digestChatId: 'self', timezone: 'Asia/Kolkata', now: () => new Date('2026-11-20T10:30:00.000Z') };
const engines: PGlite[] = [];
afterEach(async () => { while (engines.length) await engines.pop()!.close(); });

describe('reply agent', () => {
  it('uses the last 15 messages plus the last hour and only fresh incoming messages', async () => {
    const { engine, db } = await fixture(); engines.push(engine);
    const messages = Array.from({ length: 20 }, (_, index) => message(index + 1, `Message ${index + 1}`, { at: index < 15 ? `2026-11-20T08:${String(index).padStart(2, '0')}:00.000Z` : `2026-11-20T10:${String(index - 15).padStart(2, '0')}:00.000Z` }));
    const seen: ReplyAnalyzeInput[] = [];
    const { port } = telegram(messages);
    const agent = new ReplyAgent(db, port, analyzer(decision({}), seen), options);
    const summary = await agent.scanOnce('manual');
    expect(summary.chats).toBe(1);
    expect(seen).toHaveLength(1);
    const input = seen[0]!;
    expect(input.chatTitle).toBe('Founders Group');
    // Last 15 = ids 6..20; the hour window overlaps the newest five.
    expect(input.messages.map((m) => m.id)).toEqual(Array.from({ length: 15 }, (_, index) => index + 6));
    expect(input.freshMessageIds).toEqual([16, 17, 18, 19, 20]);
    expect(input.ownerNames).toEqual(['Ravi', 'Ravikant']);
    // Direct messages are not scanned.
    expect(input.chatTitle).not.toBe('Direct message');
  });

  it('skips a group with no new incoming message', async () => {
    const { engine, db } = await fixture(); engines.push(engine);
    await db.query(`INSERT INTO reply_scans(chat_id,last_scanned_message_id,last_scanned_at) VALUES(-1001,20,'2026-11-20T10:00:00Z')`);
    const seen: ReplyAnalyzeInput[] = [];
    const { port, sent } = telegram([message(18, 'old'), message(19, 'old'), message(20, 'old')]);
    const agent = new ReplyAgent(db, port, analyzer(decision({}), seen), options);
    const summary = await agent.scanOnce('manual');
    expect(summary.skipped).toBe(1);
    expect(seen).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('does not treat the owner own message as a trigger', async () => {
    const { engine, db } = await fixture(); engines.push(engine);
    const seen: ReplyAnalyzeInput[] = [];
    const { port, sent } = telegram([message(20, 'I will send it', { self: true }), message(21, 'thanks', { self: true })]);
    const agent = new ReplyAgent(db, port, analyzer(decision({}), seen), options);
    expect((await agent.scanOnce('manual')).suggestions).toBe(0);
    expect(seen).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('stores one suggestion and sends one digest to Saved Messages', async () => {
    const { engine, db } = await fixture(); engines.push(engine);
    const { port, sent } = telegram([message(20, 'Can you confirm the delivery date?')]);
    const agent = new ReplyAgent(db, port, analyzer(decision({})), options);
    const summary = await agent.scanOnce('manual');
    expect(summary.suggestions).toBe(1);
    expect(summary.delivered).toBe(1);
    const row = (await db.query('SELECT chat_title,trigger_message_id,addressed_to,suggested_text,delivered_at,delivery_message_id FROM reply_suggestions')).rows[0]!;
    expect(row['chat_title']).toBe('Founders Group');
    expect(row['trigger_message_id']).toBe(20);
    expect(row['suggested_text']).toContain('Friday works');
    expect(row['delivery_message_id']).toBe(700);
    expect(row['delivered_at']).not.toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.chatId).toBe('99');
    expect(sent[0]!.text).toContain('Founders Group');
    expect(sent[0]!.text).toContain('Yes, Friday works');
  });

  it('ignores irrelevant messages and still advances the cursor', async () => {
    const { engine, db } = await fixture(); engines.push(engine);
    const { port, sent } = telegram([message(20, 'Launch announcement tomorrow')]);
    const agent = new ReplyAgent(db, port, analyzer(decision({ relevant: false, reason: 'Announcement, no owner action', suggestedText: '' })), options);
    const summary = await agent.scanOnce('manual');
    expect(summary.suggestions).toBe(0);
    expect(sent).toHaveLength(0);
    expect((await db.query('SELECT count(*)::int AS n FROM reply_suggestions')).rows[0]).toEqual({ n: 0 });
    expect((await db.query('SELECT last_scanned_message_id FROM reply_scans WHERE chat_id=-1001')).rows[0]).toEqual({ last_scanned_message_id: 20 });
  });

  it('does not duplicate a suggestion for the same trigger message', async () => {
    const { engine, db } = await fixture(); engines.push(engine);
    const { port } = telegram([message(20, 'Can you confirm the delivery date?')]);
    await new ReplyAgent(db, port, analyzer(decision({})), options).scanOnce('manual');
    // A retry that resets the cursor must not duplicate or re-send nothing new.
    await db.query('UPDATE reply_scans SET last_scanned_message_id=0 WHERE chat_id=-1001');
    const summary = await new ReplyAgent(db, port, analyzer(decision({})), options).scanOnce('manual');
    expect(summary.suggestions).toBe(0);
    expect((await db.query('SELECT count(*)::int AS n FROM reply_suggestions')).rows[0]).toEqual({ n: 1 });
  });

  it('records provider failure without advancing the cursor', async () => {
    const { engine, db } = await fixture(); engines.push(engine);
    const { port } = telegram([message(20, 'Can you confirm the delivery date?')]);
    const failure: ProviderResult<ReplyDecision> = { ok: false, code: 'rate_limited', retryable: true, retryAt: null, detail: 'Provider HTTP 429' };
    const summary = await new ReplyAgent(db, port, analyzer(failure), options).scanOnce('manual');
    expect(summary.failed).toBe(0);
    expect(summary.suggestions).toBe(0);
    const row = (await db.query('SELECT last_scanned_message_id,last_error FROM reply_scans WHERE chat_id=-1001')).rows[0]!;
    expect(row['last_scanned_message_id']).toBe(0);
    expect(row['last_error']).toContain('429');
  });

  it('advances past an unparseable model answer instead of looping', async () => {
    const { engine, db } = await fixture(); engines.push(engine);
    const { port } = telegram([message(20, 'Can you confirm the delivery date?')]);
    const invalid: ProviderResult<ReplyDecision> = { ok: false, code: 'invalid_response', retryable: false, retryAt: null, detail: 'Model answer failed validation' };
    const summary = await new ReplyAgent(db, port, analyzer(invalid), options).scanOnce('manual');
    expect(summary.suggestions).toBe(0);
    const row = (await db.query('SELECT last_scanned_message_id,last_error FROM reply_scans WHERE chat_id=-1001')).rows[0]!;
    expect(row['last_scanned_message_id']).toBe(20);
    expect(row['last_error']).toContain('validation');
  });

  it('stores without delivery when the digest is off', async () => {
    const { engine, db } = await fixture(); engines.push(engine);
    const { port, sent } = telegram([message(20, 'Can you confirm the delivery date?')]);
    const summary = await new ReplyAgent(db, port, analyzer(decision({})), { ...options, digestChatId: 'off' }).scanOnce('manual');
    expect(summary.suggestions).toBe(1);
    expect(summary.delivered).toBe(0);
    expect(sent).toHaveLength(0);
    expect((await db.query('SELECT delivered_at FROM reply_suggestions')).rows[0]).toEqual({ delivered_at: null });
  });
});
