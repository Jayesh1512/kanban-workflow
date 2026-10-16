import { z } from 'zod';
import type { CardSummary, Ctx, Id, SetBy, WriteOpts } from '../contracts/index.ts';
import { AppError, IdSchema } from '../contracts/index.ts';
import { record } from '../log/index.ts';
import { actor, lane, setBy, summary, validate } from './helpers.ts';
import { workflowInitialStage } from './workflow-stages.ts';

export function createCard(
  ctx: Ctx,
  i: {
    laneId: Id;
    title: string;
    summary?: string;
    stageId?: Id;
    chatId?: Id;
    messageId?: Id;
    companyId?: Id | null;
    fromHistory?: boolean;
  },
  o?: WriteOpts,
): CardSummary {
  validate(
    z.strictObject({
      laneId: IdSchema,
      title: z.string().min(1),
      summary: z.string().optional(),
      stageId: IdSchema.optional(),
      chatId: IdSchema.optional(),
      messageId: IdSchema.optional(),
      companyId: IdSchema.nullable().optional(),
      fromHistory: z.boolean().optional(),
    }),
    i,
  );
  const by = setBy(ctx, o);
  const kind = actor(ctx);
  return ctx.db.tx(() => {
    const l = lane(ctx, i.laneId);
    if (l.archived) throw new AppError('invalid', 'Lane is archived');
    const stage = l.stages.find((s) => s.id === (i.stageId ?? workflowInitialStage(ctx, i.laneId) ?? l.stages[0]?.id));
    if (!stage) throw new AppError('invalid', 'Stage is not in lane');
    if (i.companyId != null && !ctx.db.get('SELECT id FROM company WHERE id=?', i.companyId))
      throw new AppError('not_found', 'Company not found');
    const m =
      i.messageId === undefined
        ? undefined
        : ctx.db.get<{ chat_id: Id; sent_at: string }>(
            'SELECT m.chat_id,m.sent_at FROM message m JOIN chat ch ON ch.id=m.chat_id WHERE m.id=? AND m.deleted_at IS NULL AND ch.withdrawn_at IS NULL',
            i.messageId,
          );
    if (i.messageId !== undefined && !m) throw new AppError('not_found', 'Message not found');
    if (m && i.chatId !== undefined && i.chatId !== m.chat_id) throw new AppError('invalid', 'Message chat mismatch');
    const chatId = i.chatId ?? m?.chat_id;
    if (chatId !== undefined && !ctx.db.get('SELECT id FROM chat WHERE id=? AND withdrawn_at IS NULL', chatId))
      throw new AppError('not_found', 'Chat not found');
    const id = ctx.db.run(
      'INSERT INTO card(lane_id,stage_id,title,summary,text_set_by,company_id,company_set_by,created_by_kind,created_from_message_id,from_history,stage_human_set_at,last_change_by_kind,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      i.laneId,
      stage.id,
      i.title,
      i.summary ?? '',
      by,
      i.companyId ?? null,
      i.companyId == null ? null : by,
      kind,
      i.messageId ?? null,
      Number(i.fromHistory ?? false),
      by === 'human' ? ctx.now().toISOString() : null,
      kind,
      ctx.now().toISOString(),
    ).lastInsertRowid;
    if (chatId !== undefined) ctx.db.run('INSERT INTO card_chat(card_id,chat_id) VALUES (?,?)', id, chatId);
    record(ctx, {
      action: 'card.create',
      subjectKind: 'card',
      subjectId: id,
      after: {
        laneId: i.laneId,
        stageId: stage.id,
        title: i.title,
        summary: i.summary ?? '',
        companyId: i.companyId ?? null,
      },
      reason: o?.reason,
      messageIds: i.messageId === undefined ? [] : [i.messageId],
      decisionId: o?.decisionId,
      correctsId: o?.correctsLogId,
    });
    if (i.messageId !== undefined) attachMessage(ctx, i.messageId, id, o);
    return summary(ctx, id);
  });
}
export function moveCard(
  ctx: Ctx,
  cardId: Id,
  i: { stageId: Id; criterion?: string; evidenceMessageIds?: Id[]; followsHumanOverride?: boolean },
  o?: WriteOpts,
): void {
  validate(IdSchema, cardId);
  validate(
    z.strictObject({
      stageId: IdSchema,
      criterion: z.string().optional(),
      evidenceMessageIds: z.array(IdSchema).optional(),
      followsHumanOverride: z.boolean().optional(),
    }),
    i,
  );
  const by = setBy(ctx, o);
  ctx.db.tx(() => {
    const before = summary(ctx, cardId);
    if (before.archived) throw new AppError('invalid', 'Card is archived');
    const target = ctx.db.get<{ lane_id: Id }>(
      'SELECT s.lane_id FROM stage s JOIN lane l ON l.id=s.lane_id WHERE s.id=? AND s.removed_at IS NULL AND l.archived_at IS NULL',
      i.stageId,
    );
    if (!target) throw new AppError('invalid', 'Inactive stage');
    if (ctx.actor.kind === 'agent' && target.lane_id !== before.laneId)
      throw new AppError('forbidden', 'Cross-lane move requires human');
    if (
      ctx.db.get("SELECT key FROM workflow_stage WHERE stage_id=? AND key='blocked'", i.stageId) &&
      !ctx.db.get(
        'SELECT card_id FROM workflow_ticket WHERE card_id=? AND blocked_reason IS NOT NULL AND (next_action IS NOT NULL OR follow_up_at IS NOT NULL)',
        cardId,
      )
    )
      throw new AppError('invalid', 'Blocked requires a reason and next action or follow-up');
    for (const id of i.evidenceMessageIds ?? [])
      if (!ctx.db.get('SELECT id FROM message WHERE id=?', id)) throw new AppError('not_found', 'Evidence not found');
    ctx.db.run(
      'UPDATE card SET lane_id=?,stage_id=?,stage_human_set_at=CASE WHEN ? THEN ? ELSE stage_human_set_at END,last_change_by_kind=? WHERE id=?',
      target.lane_id,
      i.stageId,
      Number(by === 'human'),
      ctx.now().toISOString(),
      actor(ctx),
      cardId,
    );
    if (by === 'human' && ctx.db.get('SELECT id FROM workflow_config WHERE lane_id=?', target.lane_id))
      ctx.db.run(
        "INSERT INTO workflow_field_source(card_id,field,human) VALUES (?,'stage',1) ON CONFLICT(card_id,field) DO UPDATE SET human=1,source_message_ids='[]',source_chat_ids='[]'",
        cardId,
      );
    record(ctx, {
      action: 'card.move',
      subjectKind: 'card',
      subjectId: cardId,
      before: { laneId: before.laneId, stageId: before.stageId },
      after: { laneId: target.lane_id, stageId: i.stageId, criterion: i.criterion ?? '' },
      reason: o?.reason,
      messageIds: i.evidenceMessageIds,
      decisionId: o?.decisionId,
      correctsId: o?.correctsLogId,
      followsHumanOverride: i.followsHumanOverride,
    });
  });
}
export function attachMessage(ctx: Ctx, messageId: Id, cardId: Id | null, o?: WriteOpts): void {
  validate(IdSchema, messageId);
  if (cardId !== null) validate(IdSchema, cardId);
  const by = setBy(ctx, o);
  ctx.db.tx(() => {
    const m = ctx.db.get<{ chat_id: Id; sent_at: string }>(
      'SELECT m.chat_id,m.sent_at FROM message m JOIN chat ch ON ch.id=m.chat_id WHERE m.id=? AND m.deleted_at IS NULL AND ch.withdrawn_at IS NULL',
      messageId,
    );
    if (!m) throw new AppError('not_found', 'Message not found');
    const before = ctx.db.get<{ card_id: Id | null; set_by: SetBy }>(
      'SELECT card_id,set_by FROM card_message WHERE message_id=?',
      messageId,
    );
    if (ctx.actor.kind === 'agent' && before?.set_by === 'human')
      throw new AppError('forbidden', 'Human attachment is locked');
    if (cardId !== null) {
      const card = summary(ctx, cardId);
      if (card.archived || lane(ctx, card.laneId).archived) throw new AppError('invalid', 'Card or lane is archived');
      if (
        by === 'agent' &&
        !ctx.db.get('SELECT card_id FROM card_chat WHERE card_id=? AND chat_id=?', cardId, m.chat_id)
      )
        throw new AppError('forbidden', 'Chat is not linked');
      ctx.db.run('INSERT OR IGNORE INTO card_chat(card_id,chat_id) VALUES (?,?)', cardId, m.chat_id);
    }
    ctx.db.run(
      'INSERT INTO card_message(message_id,card_id,set_by) VALUES (?,?,?) ON CONFLICT(message_id) DO UPDATE SET card_id=excluded.card_id,set_by=excluded.set_by',
      messageId,
      cardId,
      by,
    );
    if (cardId !== null)
      ctx.db.run(
        'UPDATE card SET last_message_at=(SELECT max(m.sent_at) FROM card_message cm JOIN message m ON m.id=cm.message_id WHERE cm.card_id=?),last_change_by_kind=? WHERE id=?',
        cardId,
        actor(ctx),
        cardId,
      );
    if (before?.card_id !== undefined && before.card_id !== null && before.card_id !== cardId)
      ctx.db.run(
        'UPDATE card SET last_message_at=(SELECT max(m.sent_at) FROM card_message cm JOIN message m ON m.id=cm.message_id WHERE cm.card_id=?),last_change_by_kind=? WHERE id=?',
        before.card_id,
        actor(ctx),
        before.card_id,
      );
    record(ctx, {
      action: cardId === null ? 'message.detach' : 'message.attach',
      subjectKind: 'message',
      subjectId: messageId,
      before: before ?? null,
      after: { cardId, setBy: by },
      messageIds: [messageId],
      reason: o?.reason,
      decisionId: o?.decisionId,
      correctsId: o?.correctsLogId,
    });
  });
}
