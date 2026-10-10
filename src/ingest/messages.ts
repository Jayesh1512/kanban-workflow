import { z } from 'zod';
import type { Ctx, Id, IsoTime, MessageHit, MessageView } from '../contracts/index.ts';
import { AppError, IdSchema, IsoTimeSchema } from '../contracts/index.ts';
export function getMessages(
  ctx: Ctx,
  q: { ids?: Id[]; chatId?: Id; cardId?: Id; contactId?: Id; companyId?: Id; limit?: number; before?: IsoTime },
): MessageView[] {
  const parsed = z
    .strictObject({
      ids: z.array(IdSchema).optional(),
      chatId: IdSchema.optional(),
      cardId: IdSchema.optional(),
      contactId: IdSchema.optional(),
      companyId: IdSchema.optional(),
      limit: z.number().int().positive().safe().optional(),
      before: IsoTimeSchema.optional(),
    })
    .safeParse(q);
  if (!parsed.success) throw new AppError('invalid', 'Invalid message query');
  if (
    q.chatId !== undefined ||
    q.cardId !== undefined ||
    q.contactId !== undefined ||
    q.before !== undefined ||
    (q.ids === undefined && q.companyId === undefined)
  )
    throw new AppError('invalid', 'not built: getMessages');
  const limit = q.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new AppError('invalid', 'Invalid message limit');
  for (const id of [...(q.ids ?? []), ...(q.companyId === undefined ? [] : [q.companyId])])
    if (!Number.isSafeInteger(id) || id < 1) throw new AppError('invalid', 'Invalid message id');
  const rows = ctx.db.all<{
    id: Id;
    chat_id: Id;
    chat_title: string;
    channel: string;
    sender_identity_id: Id;
    sender_name: string;
    contact_id: Id | null;
    teammate_id: Id | null;
    sent_at: IsoTime;
    text: string;
    media: string | null;
    reply_to_message_id: Id | null;
    edited_at: string | null;
    deleted_at: string | null;
    origin: string;
    card_id: Id | null;
  }>(
    `SELECT m.*,ch.title AS chat_title,ch.channel,i.display_name AS sender_name,i.contact_id,i.teammate_id,cm.card_id FROM message m JOIN chat ch ON ch.id=m.chat_id JOIN identity i ON i.id=m.sender_identity_id LEFT JOIN card_message cm ON cm.message_id=m.id
     WHERE (? IS NULL OR m.id IN (SELECT value FROM json_each(?))) AND (? IS NULL OR EXISTS (SELECT 1 FROM chat_participant cp JOIN identity pi ON pi.id=cp.identity_id JOIN contact_company cc ON cc.contact_id=pi.contact_id WHERE cp.chat_id=m.chat_id AND cc.company_id=? AND cc.removed=0)) ORDER BY m.sent_at DESC,m.id DESC LIMIT ?`,
    q.ids === undefined ? null : JSON.stringify(q.ids),
    q.ids === undefined ? null : JSON.stringify(q.ids),
    q.companyId ?? null,
    q.companyId ?? null,
    limit,
  );
  return rows.map((r) => ({
    id: r.id,
    chatId: r.chat_id,
    chatTitle: r.chat_title,
    channel: r.channel,
    sender: {
      identityId: r.sender_identity_id,
      name: r.sender_name,
      contactId: r.contact_id,
      teammateId: r.teammate_id,
    },
    direction: r.teammate_id === null ? 'in' : 'out',
    sentAt: r.sent_at,
    text: ctx.canReadText ? r.text : null,
    media: r.media,
    replyToId: r.reply_to_message_id,
    edited: r.edited_at !== null,
    deleted: r.deleted_at !== null,
    fromHistory: r.origin === 'history',
    cardId: r.card_id,
    teammateIds: ctx.db
      .all<{ id: Id }>(
        'SELECT DISTINCT a.teammate_id AS id FROM message_sighting ms JOIN channel_account a ON a.id=ms.account_id WHERE ms.message_id=? ORDER BY a.teammate_id',
        r.id,
      )
      .map((a) => a.id),
  }));
}

export function searchMessages(
  ctx: Ctx,
  q: { text: string; companyId?: Id; contactId?: Id; limit?: number },
): MessageHit[] {
  void ctx;
  void q;
  throw new AppError('invalid', 'not built: searchMessages');
}

export function deleteMessages(ctx: Ctx, messageIds: Id[]): void {
  void ctx;
  void messageIds;
  throw new AppError('invalid', 'not built: deleteMessages');
}
