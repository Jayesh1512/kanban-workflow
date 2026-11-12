import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PeerSnapshot } from '../shared/domain.js';
import type { Database, SqlExecutor, TelegramMessageInput } from '../shared/ports.js';
import type { TelegramStore } from '../telegram/store.js';
import { queueIntake } from '../telegram/intake.js';

const address = z.strictObject({ email: z.email().max(320), name: z.string().trim().max(300).optional() });
export const emailThreadSchema = z.strictObject({
  mailbox: z.email().max(320), // the mailbox Hermes read; namespaces thread keys and identifies our own messages
  threadKey: z.string().trim().min(1).max(500),
  subject: z.string().trim().min(1).max(500),
  labels: z.array(z.string().trim().min(1).max(100)).max(50).default([]), // provider labels (Gmail labelIds); a promotions label drops a new thread
  messages: z.array(z.strictObject({
    messageKey: z.string().trim().min(1).max(500), // provider message id; makes repeats a no-op
    from: address, to: z.array(address).max(50).default([]), cc: z.array(address).max(50).default([]),
    sentAt: z.iso.datetime({ offset: true }),
    body: z.string().max(100_000),
    sourceUrl: z.url().refine((v) => new URL(v).protocol === 'https:').optional(),
  })).min(1).max(50),
});
export type EmailThreadInput = z.input<typeof emailThreadSchema>;
export interface EmailService { ingestThread(raw: unknown): Promise<{ chatId: string | null; inclusion: 'undecided' | 'included' | 'excluded'; accepted: number; skipped?: 'promotion' }> }
// ponytail: label match only; add SPAM/TRASH or header checks here if promotions slip through.
const PROMOTION_LABELS = new Set(['CATEGORY_PROMOTIONS']);

// Telegram user IDs stay below 2^52; this range keeps an address's stable pseudo-user clear of them.
const EMAIL_USER_BASE = 1n << 60n;
export const emailUserId = (email: string): string =>
  String(EMAIL_USER_BASE + (createHash('sha256').update(email.trim().toLowerCase()).digest().readBigUInt64BE() & (EMAIL_USER_BASE - 1n)));
const EMAIL_CHAT_BASE = 4_000_000_000_000_000_000n;
const clean = (v: string) => v.replace(/["<>\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
/** Subject without reply/forward prefixes ("Re: Fwd: Cedar" → "Cedar"). */
export const cleanSubject = (subject: string): string => clean(subject).replace(/^(?:(?:re|fwd?|aw|sv)\s*:\s*)+/i, '').trim() || clean(subject);
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'aol.com']);
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov']);
const domainOf = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase();
/** Company name read off a business domain ("mail.chatprd.ai" → "chatprd"); the subject's own casing wins ("ChatPRD"). */
function companyFromDomain(domain: string, subject: string): string | null {
  const parts = domain.split('.'), n = parts.length;
  const label = n >= 3 && SECOND_LEVEL.has(parts[n - 2]!) && parts[n - 1]!.length === 2 ? parts[n - 3] : parts[n - 2];
  if (!label || FREE_MAIL.has(domain)) return null;
  const cased = subject.split(/[^\p{L}\p{N}]+/u).find((w) => w.toLowerCase() === label);
  return cased ?? label[0]!.toUpperCase() + label.slice(1);
}
/** The addresses that are not the mailbox: who the thread is with, first appearance first. */
const others = (input: z.output<typeof emailThreadSchema>) =>
  input.messages.flatMap((m) => [m.from, ...m.to, ...m.cc]).filter((a) => a.email.toLowerCase() !== input.mailbox.toLowerCase());
/**
 * Card name, standardised across sources: the counterparty's COMPANY, else the person, else the address.
 * Company = a directory company that owns the counterparty's domain (`known`), else the name read off
 * their own business domain; our own domain and free-mail domains never name a company.
 * Falls back to the cleaned subject when the mailbox is the only participant.
 */
export function counterpartyTitle(input: z.output<typeof emailThreadSchema>, known: { name: string; domains: string[] }[] = []): string {
  const who = others(input), ours = domainOf(input.mailbox);
  for (const a of who) {
    const d = domainOf(a.email);
    if (d === ours) continue;
    const hit = known.filter((c) => c.domains.some((x) => x.toLowerCase() === d));
    const company = hit.length === 1 ? hit[0]!.name : hit.length === 0 ? companyFromDomain(d, cleanSubject(input.subject)) : null; // several owners: ambiguous, so fall through
    if (company) return clean(company).slice(0, 200);
  }
  const first = who[0];
  return first ? (clean(first.name ?? '') || first.email).slice(0, 200) : cleanSubject(input.subject).slice(0, 200);
}
const line = (label: string, list: { email: string; name?: string | undefined }[]) => list.length ? `${label}: ${list.map((a) => a.name ? `${a.name} <${a.email}>` : a.email).join(', ')}\n` : '';

/**
 * Hermes pushes mailbox threads here. A thread becomes a chat that waits for the
 * same control-group approval as any Telegram chat; held messages are released
 * to analysis only after that approval (see promotePendingEmail).
 */
export class EmailIngest implements EmailService {
  constructor(private readonly db: Database, private readonly store: TelegramStore) {}
  /** Directory companies that own a counterparty's domain, so a known company is named as the directory spells it. */
  private async knownCompanies(tx: SqlExecutor, input: z.output<typeof emailThreadSchema>) {
    const domains = [...new Set(others(input).map((a) => domainOf(a.email)))];
    const rows = (await tx.query('SELECT canonical_name,domains FROM companies WHERE EXISTS(SELECT 1 FROM unnest(domains) d WHERE lower(d)=ANY($1::text[]))', [domains])).rows;
    return rows.map((r) => ({ name: String(r['canonical_name']), domains: (r['domains'] as string[]) ?? [] }));
  }
  async ingestThread(raw: unknown) {
    const input = emailThreadSchema.parse(raw);
    const key = `${input.mailbox.toLowerCase()}:${input.threadKey}`;
    // Promotions never enter the approvals list. A thread someone already admitted or rejected keeps flowing, so a stray label cannot drop a real reply.
    if (input.labels.some((l) => PROMOTION_LABELS.has(l.toUpperCase())) && !(await this.db.query('SELECT 1 FROM email_threads WHERE thread_key=$1', [key])).rowCount)
      return { chatId: null, inclusion: 'excluded' as const, accepted: 0, skipped: 'promotion' as const };
    const stored = await this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`email:thread:${key}`]);
      const existing = (await tx.query('SELECT chat_id FROM email_threads WHERE thread_key=$1', [key])).rows[0]?.['chat_id'];
      let chatId = existing == null ? undefined : String(existing);
      if (!chatId) {
        chatId = String((await tx.query("INSERT INTO chats(id,kind,title,inclusion) VALUES(-($1::bigint+nextval('email_chat_id_seq')),'email',$2,'undecided') RETURNING id", [EMAIL_CHAT_BASE, counterpartyTitle(input, await this.knownCompanies(tx, input))])).rows[0]!['id']);
        await tx.query('INSERT INTO email_threads(thread_key,chat_id,subject) VALUES($1,$2,$3)', [key, chatId, cleanSubject(input.subject)]);
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
