import { z } from 'zod';
import type { Ctx, Id, WriteOpts } from '../contracts/index.ts';
import { AppError, IdSchema } from '../contracts/index.ts';
import { record } from '../log/index.ts';
import { by, human, validate } from './helpers.ts';

export function recordReference(
  ctx: Ctx,
  i: { fromCompanyId: Id | null; toCompanyId: Id; messageId: Id; cardId: Id | null },
  o?: WriteOpts,
): Id | null {
  validate(
    z.strictObject({
      fromCompanyId: IdSchema.nullable(),
      toCompanyId: IdSchema,
      messageId: IdSchema,
      cardId: IdSchema.nullable(),
    }),
    i,
  );
  by(ctx, o);
  return ctx.db.tx(() => {
    for (const id of [i.fromCompanyId, i.toCompanyId])
      if (id !== null && !ctx.db.get('SELECT id FROM company WHERE id=?', id))
        throw new AppError('not_found', 'Company not found');
    if (
      !ctx.db.get(
        'SELECT m.id FROM message m JOIN chat ch ON ch.id=m.chat_id WHERE m.id=? AND m.deleted_at IS NULL AND ch.withdrawn_at IS NULL',
        i.messageId,
      )
    )
      throw new AppError('not_found', 'Message not found');
    if (
      i.cardId !== null &&
      !ctx.db.get('SELECT card_id FROM card_message WHERE message_id=? AND card_id=?', i.messageId, i.cardId)
    )
      throw new AppError('invalid', 'Reference card is not linked to message');
    const old = ctx.db.get<{ id: Id; removed: number }>(
      'SELECT id,removed FROM company_reference WHERE message_id=? AND to_company_id=?',
      i.messageId,
      i.toCompanyId,
    );
    // Human removal is remembered for this message, including later versions.
    if (old) return old.removed ? null : old.id;
    const id = ctx.db.run(
      'INSERT INTO company_reference(from_company_id,to_company_id,message_id,card_id) VALUES (?,?,?,?)',
      i.fromCompanyId,
      i.toCompanyId,
      i.messageId,
      i.cardId,
    ).lastInsertRowid;
    record(ctx, {
      action: 'reference.record',
      subjectKind: 'reference',
      subjectId: id,
      after: { fromCompanyId: i.fromCompanyId, toCompanyId: i.toCompanyId, cardId: i.cardId },
      messageIds: [i.messageId],
      reason: o?.reason,
      decisionId: o?.decisionId,
      correctsId: o?.correctsLogId,
    });
    return id;
  });
}
export function removeReference(ctx: Ctx, referenceId: Id): void {
  human(ctx);
  validate(IdSchema, referenceId);
  ctx.db.tx(() => {
    const before = ctx.db.get<{ message_id: Id; from_company_id: Id | null; to_company_id: Id; removed: number }>(
      'SELECT * FROM company_reference WHERE id=?',
      referenceId,
    );
    if (!before) throw new AppError('not_found', 'Reference not found');
    if (before.removed) return;
    ctx.db.run('UPDATE company_reference SET removed=1 WHERE id=?', referenceId);
    record(ctx, {
      action: 'reference.remove',
      subjectKind: 'reference',
      subjectId: referenceId,
      before: { fromCompanyId: before.from_company_id, toCompanyId: before.to_company_id },
      after: { removed: true },
      messageIds: [before.message_id],
    });
  });
}
