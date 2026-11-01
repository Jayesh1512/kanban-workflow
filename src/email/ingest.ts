import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PeerSnapshot } from '../shared/domain.js';
import type { Database, TelegramMessageInput } from '../shared/ports.js';
import type { TelegramStore } from '../telegram/store.js';
import { queueIntake } from '../telegram/intake.js';

const address = z.strictObject({ email: z.email().max(320), name: z.string().trim().max(300).optional() });
export const emailThreadSchema = z.strictObject({
  mailbox: z.email().max(320), // the mailbox Hermes read; namespaces thread keys and identifies our own messages
  threadKey: z.string().trim().min(1).max(500),
  subject: z.string().trim().min(1).max(500),
  messages: z.array(z.strictObject({
    messageKey: z.string().trim().min(1).max(500), // provider message id; makes repeats a no-op
    from: address, to: z.array(address).max(50).default([]), cc: z.array(address).max(50).default([]),
    sentAt: z.iso.datetime({ offset: true }),
    body: z.string().max(100_000),
    sourceUrl: z.url().refine((v) => new URL(v).protocol === 'https:').optional(),
  })).min(1).max(50),
});
export type EmailThreadInput = z.input<typeof emailThreadSchema>;
export interface EmailService { ingestThread(raw: unknown): Promise<{ chatId: string; inclusion: 'undecided' | 'included' | 'excluded'; accepted: number }> }

// Telegram user IDs stay below 2^52; this range keeps an address's stable pseudo-user clear of them.
const EMAIL_USER_BASE = 1n << 60n;
export const emailUserId = (email: string): string =>
  String(EMAIL_USER_BASE + (createHash('sha256').update(email.trim().toLowerCase()).digest().readBigUInt64BE() & (EMAIL_USER_BASE - 1n)));
const EMAIL_CHAT_BASE = 4_000_000_000_000_000_000n;
const line = (label: string, list: { email: string; name?: string | undefined }[]) => list.length ? `${label}: ${list.map((a) => a.name ? `${a.name} <${a.email}>` : a.email).join(', ')}\n` : '';

/**
 * Hermes pushes mailbox threads here. A thread becomes a chat that waits for the
 * same control-group approval as any Telegram chat; held messages are released
 * to analysis only after that approval (see promotePendingEmail).
 */
export class EmailIngest implements EmailService {
  constructor(private readonly db: Database, private readonly store: TelegramStore) {}
  async ingestThread(raw: unknown) {
    const input = emailThreadSchema.parse(raw);
    const key = `${input.mailbox.toLowerCase()}:${input.threadKey}`;
    const stored = await this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`email:thread:${key}`]);
      const existing = (await tx.query('SELECT chat_id FROM email_threads WHERE thread_key=$1', [key])).rows[0]?.['chat_id'];
      let chatId = existing == null ? undefined : String(existing);
      if (!chatId) {
        chatId = String((await tx.query("INSERT INTO chats(id,kind,title,inclusion) VALUES(-($1::bigint+nextval('email_chat_id_seq')),'email',$2,'undecided') RETURNING id", [EMAIL_CHAT_BASE, input.subject])).rows[0]!['id']);
        await tx.query('INSERT INTO email_threads(thread_key,chat_id) VALUES($1,$2)', [key, chatId]);
      }
      const chat = await this.store.lockedChat(tx, chatId);
      if (chat.inclusion === 'excluded') return { chatId, inclusion: chat.inclusion, accepted: 0 }; // rejected: keep no content
      const self = (await tx.query('SELECT self_user_id::text AS id FROM telegram_account')).rows[0]?.['id'] as string | undefined;
      let accepted = 0;
      for (const m of input.messages) {
        if ((await tx.query('SELECT 1 FROM email_messages WHERE chat_id=$1 AND message_key=$2', [chatId, m.messageKey])).rowCount) continue;
        const id = Number((await tx.query('SELECT coalesce(max(id),0)+1 AS id FROM email_messages WHERE chat_id=$1', [chatId])).rows[0]!['id']);
        // Our own mail is sent by the connected account's owner, so it reuses that identity: outbound detection and the team page then apply.
        const ours = m.from.email.toLowerCase() === input.mailbox.toLowerCase() && self;
        const senderId = ours || emailUserId(m.from.email);
        const at = m.sentAt;
        const snapshot = (id: string | null, kind: PeerSnapshot['kind'], names: string[], emails: string[]): PeerSnapshot => ({ id, kind, names, usernames: [], visiblePhones: [], visibleEmails: emails, observedAt: at });
        const message: Omit<TelegramMessageInput, 'chatId' | 'id'> = {
          senderId, sentAt: at, editedAt: null, replyToId: null, sourceUrl: m.sourceUrl ?? null,
          text: `Subject: ${input.subject}\n${line('From', [m.from])}${line('To', m.to)}${line('Cc', m.cc)}\n${m.body}`.trim(),
          sender: snapshot(senderId, 'user', m.from.name ? [m.from.name] : [], [m.from.email]),
          peer: snapshot(chatId, 'chat', [input.subject], []),
          forward: { isForwarded: false, sourceKind: 'unknown', originPeer: null, originName: null, originDate: null, originMessageId: null },
        };
        await tx.query('INSERT INTO email_messages(chat_id,message_key,id,pending) VALUES($1,$2,$3,$4)', [chatId, m.messageKey, id, JSON.stringify(message)]);
        accepted++;
      }
      if (chat.inclusion === 'undecided') await queueIntake(tx, chatId); // approval-first, exactly like a new Telegram chat
      return { chatId, inclusion: chat.inclusion, accepted };
    });
    if (stored.inclusion !== 'included') return stored;
    // Already approved: hand held messages to the normal ingest path (upsert + analysis jobs), outside the thread lock.
    const pending = (await this.db.query('SELECT id,pending FROM email_messages WHERE chat_id=$1 AND pending IS NOT NULL ORDER BY id', [stored.chatId])).rows;
    for (const row of pending) {
      await this.store.ingest({ type: 'message', message: { ...(row['pending'] as Omit<TelegramMessageInput, 'chatId' | 'id'>), chatId: stored.chatId, id: Number(row['id']) } });
      await this.db.query('UPDATE email_messages SET pending=NULL WHERE chat_id=$1 AND id=$2', [stored.chatId, row['id']]);
    }
    return stored;
  }
}
