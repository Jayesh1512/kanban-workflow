import type { Ctx, Id } from '../contracts/index.ts';
import { AppError, IdSchema } from '../contracts/index.ts';
import { validate } from './helpers.ts';

export function candidateCards(ctx: Ctx, chatId: Id): { cardId: Id; link: 'this_chat' | 'other_chat' }[] {
  validate(IdSchema, chatId);
  if (!ctx.db.get('SELECT id FROM chat WHERE id=?', chatId)) throw new AppError('not_found', 'Chat not found');
  const own = ctx.db.all<{ cardId: Id }>(
    `SELECT c.id AS cardId FROM card c JOIN lane l ON l.id=c.lane_id JOIN card_chat cc ON cc.card_id=c.id
     WHERE cc.chat_id=? AND c.archived_at IS NULL AND l.archived_at IS NULL ORDER BY c.last_message_at DESC,c.id DESC`,
    chatId,
  );
  const other = ctx.db.all<{ cardId: Id }>(
    `SELECT c.id AS cardId FROM card c JOIN lane l ON l.id=c.lane_id
     WHERE c.archived_at IS NULL AND l.archived_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM card_chat WHERE card_id=c.id AND chat_id=?)
     AND EXISTS (SELECT 1 FROM card_chat WHERE card_id=c.id)
     AND NOT EXISTS (SELECT 1 FROM card_offer_dismissed WHERE card_id=c.id AND chat_id=?)
     AND (c.company_id IN (
       SELECT cc.company_id FROM chat_participant cp JOIN identity i ON i.id=cp.identity_id
       JOIN contact_company cc ON cc.contact_id=i.contact_id WHERE cp.chat_id=? AND cc.removed=0
       UNION SELECT named_company_id FROM chat WHERE id=? AND named_company_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM card_chat cch JOIN chat_participant cp ON cp.chat_id=cch.chat_id JOIN identity i ON i.id=cp.identity_id
       WHERE cch.card_id=c.id AND i.contact_id IN (SELECT i2.contact_id FROM chat_participant cp2 JOIN identity i2 ON i2.id=cp2.identity_id WHERE cp2.chat_id=? AND i2.contact_id IS NOT NULL)))
     ORDER BY c.last_message_at DESC,c.id DESC LIMIT 10`,
    chatId,
    chatId,
    chatId,
    chatId,
    chatId,
  );
  return [
    ...own.map((r) => ({ ...r, link: 'this_chat' as const })),
    ...other.map((r) => ({ ...r, link: 'other_chat' as const })),
  ];
}
