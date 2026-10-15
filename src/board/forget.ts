import { z } from 'zod';
import type { Ctx, Id, SetBy } from '../contracts/index.ts';
import { IdSchema } from '../contracts/index.ts';
import { record } from '../log/index.ts';
import { validate } from './helpers.ts';

/** Purge-only callback. Joins the caller's transaction; deferred foreign keys,
 * message deletion and log redaction are the coordinator's responsibilities. */
export function forgetMessages(ctx: Ctx, messageIds: Id[]): { removedCardIds: Id[]; clearedCardIds: Id[] } {
  validate(z.array(IdSchema), messageIds);
  return ctx.db.tx(() => {
    const removedCardIds: Id[] = [],
      clearedCardIds: Id[] = [];
    const ids = JSON.stringify(messageIds);
    const affected = ctx.db.all<{ id: Id; text_set_by: SetBy }>(
      `SELECT DISTINCT c.id,c.text_set_by FROM card c JOIN card_message cm ON cm.card_id=c.id
       WHERE cm.message_id IN (SELECT value FROM json_each(?)) ORDER BY c.id`,
      ids,
    );
    ctx.db.run('DELETE FROM card_message WHERE message_id IN (SELECT value FROM json_each(?))', ids);
    for (const card of affected) {
      if (!ctx.db.get('SELECT message_id FROM card_message WHERE card_id=?', card.id)) {
        ctx.db.run('DELETE FROM card WHERE id=?', card.id);
        removedCardIds.push(card.id);
        record(ctx, {
          action: 'card.update',
          subjectKind: 'card',
          subjectId: card.id,
          after: { removed: true },
          messageIds,
        });
      } else {
        ctx.db.run(
          'DELETE FROM card_chat WHERE card_id=? AND chat_id NOT IN (SELECT m.chat_id FROM card_message cm JOIN message m ON m.id=cm.message_id WHERE cm.card_id=?)',
          card.id,
          card.id,
        );
        ctx.db.run(
          'UPDATE card SET last_message_at=(SELECT max(m.sent_at) FROM card_message cm JOIN message m ON m.id=cm.message_id WHERE cm.card_id=?) WHERE id=?',
          card.id,
          card.id,
        );
        if (card.text_set_by === 'agent') {
          ctx.db.run("UPDATE card SET title='(title removed)',summary='',needs_text=1 WHERE id=?", card.id);
          clearedCardIds.push(card.id);
        }
        record(ctx, {
          action: 'card.update',
          subjectKind: 'card',
          subjectId: card.id,
          after: { cleared: card.text_set_by === 'agent' },
          messageIds,
        });
      }
    }
    return { removedCardIds, clearedCardIds };
  });
}

/** Purge-only current-output cleanup, discovered before Agent provenance loss.
 * Does not change retained messages, card placement, company or human text. */
export function clearGeneratedText(ctx: Ctx, cardIds: Id[], messageIds: Id[]): Id[] {
  return ctx.db.tx(() => {
    const cleared: Id[] = [];
    for (const id of cardIds) {
      if (!ctx.db.get("SELECT id FROM card WHERE id=? AND text_set_by='agent'", id)) continue;
      ctx.db.run("UPDATE card SET title='(title removed)',summary='',needs_text=1 WHERE id=?", id);
      record(ctx, { action: 'card.update', subjectKind: 'card', subjectId: id, after: { cleared: true }, messageIds });
      cleared.push(id);
    }
    return cleared;
  });
}
