import { z } from 'zod';
import type { Ctx, Id, IsoTime, MessageHit, MessageView } from '../contracts/index.ts';
import { AppError, IdSchema, IsoTimeSchema } from '../contracts/index.ts';

const querySchema = z.strictObject({
  ids: z.array(IdSchema).optional(),
  chatId: IdSchema.optional(),
  cardId: IdSchema.optional(),
  contactId: IdSchema.optional(),
  companyId: IdSchema.optional(),
  limit: z.number().int().positive().safe().optional(),
  before: IsoTimeSchema.optional(),
});
const searchSchema = z.strictObject({
  text: z
    .string()
    .trim()
    .min(1)
    .refine((text) => !text.includes('\0')),
  companyId: IdSchema.optional(),
  contactId: IdSchema.optional(),
  limit: z.number().int().positive().safe().optional(),
});
type MessageQuery = z.infer<typeof querySchema>;

interface MessageRow {
  id: Id;
  chat_id: Id;
  chat_title: string;
  channel: string;
  sender_identity_id: Id;
  sender_name: string;
  contact_id: Id | null;
  teammate_id: Id | null;
  sent_at: IsoTime;
  text: string | null;
  media: string | null;
  reply_to_message_id: Id | null;
  edited_at: IsoTime | null;
  deleted_at: IsoTime | null;
  origin: 'live' | 'history';
  card_id: Id | null;
}

// Conversation companies come from active participant links, the owner's named
// company and the attached card. Mentions of another company are references,
// not a claim that the conversation is with that company.
const conversationCompaniesSql = `
  SELECT cc.company_id FROM chat_participant cp
    JOIN identity pi ON pi.id=cp.identity_id
    JOIN contact_company cc ON cc.contact_id=pi.contact_id
    WHERE cp.chat_id=m.chat_id AND cc.removed=0
  UNION SELECT ch.named_company_id WHERE ch.named_company_id IS NOT NULL
  UNION SELECT c.company_id FROM card c WHERE c.id=cm.card_id AND c.company_id IS NOT NULL`;

function readRows(ctx: Ctx, q: MessageQuery, match?: string): MessageRow[] {
  if (q.ids?.length === 0) return [];
  const ids = q.ids === undefined ? null : JSON.stringify(q.ids);
  return ctx.db.all<MessageRow>(
    `SELECT m.id,m.chat_id,ch.title AS chat_title,ch.channel,m.sender_identity_id,
      i.display_name AS sender_name,i.contact_id,i.teammate_id,m.sent_at,
      CASE WHEN ? THEN m.text ELSE NULL END AS text,m.media,m.reply_to_message_id,
      m.edited_at,m.deleted_at,m.origin,cm.card_id
    FROM message m JOIN chat ch ON ch.id=m.chat_id
    JOIN identity i ON i.id=m.sender_identity_id
    LEFT JOIN card_message cm ON cm.message_id=m.id
    WHERE (? IS NULL OR m.id IN (SELECT value FROM json_each(?)))
      AND (? IS NULL OR m.chat_id=?)
      AND (? IS NULL OR cm.card_id=?)
      AND (? IS NULL OR EXISTS (
        SELECT 1 FROM chat_participant cp JOIN identity pi ON pi.id=cp.identity_id
        WHERE cp.chat_id=m.chat_id AND pi.contact_id=?))
      AND (? IS NULL OR ? IN (${conversationCompaniesSql}))
      AND (? IS NULL OR m.sent_at<?)
      ${match === undefined ? '' : 'AND m.id IN (SELECT rowid FROM message_fts WHERE message_fts MATCH ?)'}
    ORDER BY m.sent_at DESC,m.id DESC LIMIT ?`,
    ctx.canReadText ? 1 : 0,
    ids,
    ids,
    q.chatId ?? null,
    q.chatId ?? null,
    q.cardId ?? null,
    q.cardId ?? null,
    q.contactId ?? null,
    q.contactId ?? null,
    q.companyId ?? null,
    q.companyId ?? null,
    q.before ?? null,
    q.before ?? null,
    ...(match === undefined ? [] : [match]),
    q.limit ?? q.ids?.length ?? 50,
  );
}

function buildMessages(ctx: Ctx, rows: MessageRow[]): MessageView[] {
  const sightings = new Map<Id, Id[]>();
  if (rows.length > 0) {
    for (const sighting of ctx.db.all<{ message_id: Id; teammate_id: Id }>(
      `SELECT DISTINCT ms.message_id,a.teammate_id FROM message_sighting ms
       JOIN channel_account a ON a.id=ms.account_id
       WHERE ms.message_id IN (SELECT value FROM json_each(?))
       ORDER BY ms.message_id,a.teammate_id`,
      JSON.stringify(rows.map((row) => row.id)),
    )) {
      const teammates = sightings.get(sighting.message_id) ?? [];
      teammates.push(sighting.teammate_id);
      sightings.set(sighting.message_id, teammates);
    }
  }
  return rows.map((row) => ({
    id: row.id,
    chatId: row.chat_id,
    chatTitle: row.chat_title,
    channel: row.channel,
    sender: {
      identityId: row.sender_identity_id,
      name: row.sender_name,
      contactId: row.contact_id,
      teammateId: row.teammate_id,
    },
    direction: row.teammate_id === null ? 'in' : 'out',
    sentAt: row.sent_at,
    text: ctx.canReadText ? row.text : null,
    media: row.media,
    replyToId: row.reply_to_message_id,
    edited: row.edited_at !== null,
    deleted: row.deleted_at !== null,
    fromHistory: row.origin === 'history',
    cardId: row.card_id,
    teammateIds: sightings.get(row.id) ?? [],
  }));
}

/** Newest first, with descending id to break equal sent times. `before` is exclusive.
 * Explicit ids are not silently clipped by the default recent-message window.
 * Timeline consumers may reverse the returned window for chronological display.
 */
export function getMessages(
  ctx: Ctx,
  q: { ids?: Id[]; chatId?: Id; cardId?: Id; contactId?: Id; companyId?: Id; limit?: number; before?: IsoTime },
): MessageView[] {
  const parsed = querySchema.safeParse(q);
  if (!parsed.success) throw new AppError('invalid', 'Invalid message query');
  return buildMessages(ctx, readRows(ctx, parsed.data));
}

export function searchMessages(
  ctx: Ctx,
  q: { text: string; companyId?: Id; contactId?: Id; limit?: number },
): MessageHit[] {
  if (!ctx.canReadText) throw new AppError('forbidden', 'Message text permission required');
  const parsed = searchSchema.safeParse(q);
  if (!parsed.success) throw new AppError('invalid', 'Invalid message search');
  // Treat the text as a literal FTS phrase. Quotes are escaped for FTS as well as
  // SQL parameters, so punctuation/operators cannot become a query program.
  const match = `"${parsed.data.text.replaceAll('"', '""')}"`;
  const messages = buildMessages(ctx, readRows(ctx, parsed.data, match));
  return messages.map((message) => {
    const companies = ctx.db
      .all<{ id: Id; name: string }>(
        `SELECT co.id,co.name FROM message m JOIN chat ch ON ch.id=m.chat_id
         LEFT JOIN card_message cm ON cm.message_id=m.id
         JOIN company co ON co.id IN (${conversationCompaniesSql})
         WHERE m.id=? ORDER BY co.id`,
        message.id,
      )
      .map((company) => ({ id: company.id, name: company.name }));
    const card =
      message.cardId === null
        ? undefined
        : ctx.db.get<{ id: Id; title: string }>('SELECT id,title FROM card WHERE id=?', message.cardId);
    return { message, companies, card: card === undefined ? null : { id: card.id, title: card.title } };
  });
}

/** Purge callback: joins the caller's synchronous transaction. The caller owns
 * host/board/graph/agent cleanup, log redaction and the final withdrawal entry.
 */
export function deleteMessages(ctx: Ctx, messageIds: Id[]): void {
  const parsed = z.array(IdSchema).safeParse(messageIds);
  if (!parsed.success) throw new AppError('invalid', 'Invalid message ids');
  ctx.db.tx(() => {
    // FKs cascade versions/sightings and dependent rows; FTS triggers remove text.
    ctx.db.run('DELETE FROM message WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(parsed.data));
    // Covers empty withdrawals too, after graph has removed a named company with
    // deferred FKs. Active chats retain their owner's company assignment.
    ctx.db.run('UPDATE chat SET named_company_id=NULL WHERE withdrawn_at IS NOT NULL');
  });
}
