import { z } from 'zod';
import type { Ctx, Id, SetBy, WriteOpts } from '../contracts/index.ts';
import { AppError, IdSchema } from '../contracts/index.ts';
import { record } from '../log/index.ts';
import { actor, setBy, summary, validate } from './helpers.ts';

export function updateCard(
  ctx: Ctx,
  cardId: Id,
  i: { title?: string; summary?: string; companyId?: Id | null },
  o?: WriteOpts,
): void {
  validate(IdSchema, cardId);
  validate(
    z.strictObject({
      title: z.string().trim().min(1).optional(),
      summary: z.string().optional(),
      companyId: IdSchema.nullable().optional(),
    }),
    i,
  );
  const by = setBy(ctx, o);
  ctx.db.tx(() => {
    const before = ctx.db.get<{
      title: string;
      summary: string;
      text_set_by: SetBy;
      company_id: Id | null;
      company_set_by: SetBy | null;
    }>('SELECT * FROM card WHERE id=?', cardId);
    if (!before) throw new AppError('not_found', 'Card not found');
    if (
      ctx.actor.kind === 'agent' &&
      (i.title !== undefined || i.summary !== undefined) &&
      before.text_set_by === 'human'
    )
      throw new AppError('forbidden', 'Human card text is locked');
    if (ctx.actor.kind === 'agent' && i.companyId !== undefined && before.company_set_by === 'human')
      throw new AppError('forbidden', 'Human card company is locked');
    if (i.companyId != null && !ctx.db.get('SELECT id FROM company WHERE id=?', i.companyId))
      throw new AppError('not_found', 'Company not found');
    const hasText = i.title !== undefined || i.summary !== undefined;
    ctx.db.run(
      'UPDATE card SET title=?,summary=?,text_set_by=?,needs_text=CASE WHEN ? THEN 0 ELSE needs_text END,company_id=?,company_set_by=?,last_change_by_kind=? WHERE id=?',
      i.title ?? before.title,
      i.summary ?? before.summary,
      hasText ? by : before.text_set_by,
      Number(hasText),
      i.companyId === undefined ? before.company_id : i.companyId,
      i.companyId === undefined ? before.company_set_by : by,
      actor(ctx),
      cardId,
    );
    record(ctx, {
      action: 'card.update',
      subjectKind: 'card',
      subjectId: cardId,
      before: { title: before.title, summary: before.summary, companyId: before.company_id },
      after: {
        title: i.title ?? before.title,
        summary: i.summary ?? before.summary,
        companyId: i.companyId === undefined ? before.company_id : i.companyId,
      },
      reason: o?.reason,
      decisionId: o?.decisionId,
      correctsId: o?.correctsLogId,
    });
  });
}

export function dismissCardOffer(ctx: Ctx, cardId: Id, chatId: Id): void {
  if (ctx.actor.kind === 'agent') throw new AppError('forbidden', 'Human required');
  actor(ctx);
  validate(IdSchema, cardId);
  validate(IdSchema, chatId);
  ctx.db.tx(() => {
    summary(ctx, cardId);
    if (!ctx.db.get('SELECT id FROM chat WHERE id=?', chatId)) throw new AppError('not_found', 'Chat not found');
    if (ctx.db.run('INSERT OR IGNORE INTO card_offer_dismissed(card_id,chat_id) VALUES (?,?)', cardId, chatId).changes)
      record(ctx, { action: 'card.offer_dismiss', subjectKind: 'card', subjectId: cardId, after: { chatId } });
  });
}

function archive(ctx: Ctx, cardId: Id, archived: boolean): void {
  if (ctx.actor.kind === 'agent') throw new AppError('forbidden', 'Human required');
  actor(ctx);
  validate(IdSchema, cardId);
  ctx.db.tx(() => {
    const before = summary(ctx, cardId);
    if (before.archived === archived) return;
    if (!archived && ctx.db.get('SELECT id FROM lane WHERE id=? AND archived_at IS NOT NULL', before.laneId))
      throw new AppError('invalid', 'Lane is archived');
    ctx.db.run(
      'UPDATE card SET archived_at=?,last_change_by_kind=? WHERE id=?',
      archived ? ctx.now().toISOString() : null,
      actor(ctx),
      cardId,
    );
    record(ctx, {
      action: archived ? 'card.archive' : 'card.unarchive',
      subjectKind: 'card',
      subjectId: cardId,
      before: { archived: before.archived },
      after: { archived },
    });
  });
}
export function archiveCard(ctx: Ctx, cardId: Id): void {
  archive(ctx, cardId, true);
}
export function unarchiveCard(ctx: Ctx, cardId: Id): void {
  archive(ctx, cardId, false);
}
