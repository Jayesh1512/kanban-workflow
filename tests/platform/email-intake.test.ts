import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { telegramFixture, fixtureMessage } from './telegram-fixture.js';
import { ChatIntake } from '../../src/telegram/intake.js';
import { DurableControlBus } from '../../src/telegram/control.js';
import { EmailIngest, emailUserId } from '../../src/email/ingest.js';
import type { TelegramPort } from '../../src/shared/ports.js';

const mailbox = 'me@antseed.test';
const thread = (extra: Partial<Parameters<EmailIngest['ingestThread']>[0]> = {}) => ({
  mailbox, threadKey: 'gmail-1', subject: 'Cedar integration', messages: [
    { messageKey: 'm1', from: { email: 'riya@cedar.test', name: 'Riya Shah' }, to: [{ email: mailbox }], sentAt: '2026-11-01T09:00:00+05:30', body: 'We would like to integrate by Friday.' },
  ], ...extra });

describe('email threads use the Telegram approval flow, real SQL', () => {
  let f: Awaited<ReturnType<typeof telegramFixture>>;
  let sent: { chatId: string; text: string; randomId: string; id: number }[];
  let email: EmailIngest, bus: DurableControlBus;
  beforeEach(async () => {
    f = await telegramFixture({ approvalFirst: true }); sent = [];
    await f.store.upsertDialog({ id: '-1001', kind: 'supergroup', title: 'Approvals', username: null, archived: false });
    await f.db.query("UPDATE chats SET is_control=true,inclusion='excluded' WHERE id=-1001");
    const port = { status: async () => ({ state: 'ready' }), authorizedSelf: async () => '123',
      sendControlMessage: async (input: { chatId: string; text: string; randomId: string }) => { const row = { ...input, id: 50 + sent.length }; sent.push(row); return { messageId: row.id }; },
      getHistory: async () => ({ messages: sent.map((s) => fixtureMessage(s.id, s.chatId, s.text)), next: null, complete: true }) } as unknown as TelegramPort;
    void new ChatIntake(f.db, f.store, port); bus = new DurableControlBus(f.db, port, f.store); email = new EmailIngest(f.db, f.store);
  });
  afterEach(async () => { await f.db.close(); });
  const reply = async (text: string, messageId = 100) => { await f.store.ingest({ type: 'message', message: { ...fixtureMessage(messageId, '-1001', text), replyToId: sent[0]!.id, sentAt: new Date().toISOString() } }); await bus.tick(); };

  it('holds the thread, asks in Telegram, and releases content to analysis only after approve', async () => {
    const pushed = await email.ingestThread(thread());
    expect(pushed).toMatchObject({ inclusion: 'undecided', accepted: 1 });
    for (const table of ['messages', 'analysis_jobs', 'tickets', 'history_cursors']) expect((await f.db.query(`SELECT 1 FROM ${table} WHERE chat_id=$1`, [pushed.chatId])).rowCount).toBe(0);
    await bus.tick();
    expect(sent).toHaveLength(1); expect(sent[0]!.text).toContain('Add this email thread'); expect(sent[0]!.text).toContain('Cedar integration');
    expect(sent[0]!.text).not.toContain('integrate by Friday');
    await reply('approve');
    expect((await f.db.query('SELECT inclusion FROM chats WHERE id=$1', [pushed.chatId])).rows[0]).toEqual({ inclusion: 'included' });
    const m = (await f.db.query('SELECT id,sender_id,text,sender_snapshot FROM messages WHERE chat_id=$1', [pushed.chatId])).rows;
    expect(m).toHaveLength(1); expect(String(m[0]!['sender_id'])).toBe(emailUserId('riya@cedar.test'));
    expect(m[0]!['text']).toContain('Subject: Cedar integration'); expect(m[0]!['text']).toContain('From: Riya Shah <riya@cedar.test>');
    expect(m[0]!['sender_snapshot']).toMatchObject({ names: ['Riya Shah'], visibleEmails: ['riya@cedar.test'] });
    expect((await f.db.query('SELECT 1 FROM analysis_jobs WHERE chat_id=$1', [pushed.chatId])).rowCount).toBe(1);
    expect((await f.db.query('SELECT 1 FROM email_messages WHERE chat_id=$1 AND pending IS NOT NULL', [pushed.chatId])).rowCount).toBe(0);
    // No Telegram worker may pick it up.
    expect((await f.db.query('SELECT 1 FROM history_cursors WHERE chat_id=$1', [pushed.chatId])).rowCount).toBe(0);
  });

  it('repeats are no-ops; new messages on an approved thread flow straight to analysis; our own mail uses the account identity', async () => {
    const first = await email.ingestThread(thread()); await bus.tick(); await reply('approve');
    expect(await email.ingestThread(thread())).toMatchObject({ chatId: first.chatId, inclusion: 'included', accepted: 0 });
    const more = await email.ingestThread(thread({ messages: [
      { messageKey: 'm1', from: { email: 'riya@cedar.test' }, to: [], cc: [], sentAt: '2026-11-01T09:00:00+05:30', body: 'x' },
      { messageKey: 'm2', from: { email: mailbox, name: 'Me' }, to: [{ email: 'riya@cedar.test' }], cc: [], sentAt: '2026-11-01T10:00:00+05:30', body: 'Sounds good, sending the spec.' },
    ] }));
    expect(more.accepted).toBe(1);
    const rows = (await f.db.query('SELECT id,sender_id FROM messages WHERE chat_id=$1 ORDER BY id', [first.chatId])).rows;
    expect(rows.map((r) => String(r['sender_id']))).toEqual([emailUserId('riya@cedar.test'), '123']);
  });

  it('reject drops the content and later pushes are discarded', async () => {
    const pushed = await email.ingestThread(thread()); await bus.tick(); await reply('reject');
    expect((await f.db.query('SELECT 1 FROM email_messages WHERE chat_id=$1 AND pending IS NOT NULL', [pushed.chatId])).rowCount).toBe(0);
    expect(await email.ingestThread(thread({ threadKey: 'gmail-1' }))).toMatchObject({ inclusion: 'excluded', accepted: 0 });
    expect((await f.db.query('SELECT 1 FROM messages WHERE chat_id=$1', [pushed.chatId])).rowCount).toBe(0);
  });

  it('the same sender gets one stable identity across threads; thread keys are namespaced by mailbox', async () => {
    const a = await email.ingestThread(thread()); const b = await email.ingestThread(thread({ threadKey: 'gmail-2' })); const c = await email.ingestThread(thread({ mailbox: 'other@antseed.test' }));
    expect(new Set([a.chatId, b.chatId, c.chatId]).size).toBe(3);
    expect(emailUserId('Riya@Cedar.test')).toBe(emailUserId('riya@cedar.test'));
    expect(BigInt(emailUserId('riya@cedar.test'))).toBeGreaterThan(2n ** 52n);
  });
});
