import { z } from 'zod';
import type { BoardView, CardDetail, CardSummary, Ctx, Id } from '../contracts/index.ts';
import { IdSchema } from '../contracts/index.ts';
import { cardReferencePanels } from '../graph/index.ts';
import { getMessages } from '../ingest/index.ts';
import { boardVersion, history } from '../log/index.ts';
import { lane, summary, validate } from './helpers.ts';

export function getBoard(ctx: Ctx): BoardView {
  return {
    version: boardVersion(ctx.db),
    lanes: ctx.db.all<{ id: Id }>('SELECT id FROM lane WHERE archived_at IS NULL ORDER BY position,id').map((r) => ({
      ...lane(ctx, r.id),
      cards: ctx.db
        .all<{ id: Id }>('SELECT id FROM card WHERE lane_id=? AND archived_at IS NULL ORDER BY id', r.id)
        .map((c) => summary(ctx, c.id)),
    })),
    openReviewCount: ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM review_item WHERE status='open'")?.n ?? 0,
  };
}

export function getCard(ctx: Ctx, cardId: Id): CardDetail {
  validate(IdSchema, cardId);
  const card = summary(ctx, cardId);
  const ids = ctx.db
    .all<{ message_id: Id }>('SELECT message_id FROM card_message WHERE card_id=?', cardId)
    .map((r) => r.message_id);
  const messageLogs = ids.flatMap((id) =>
    history(ctx, { subjectKind: 'message', subjectId: id, limit: Number.MAX_SAFE_INTEGER }),
  );
  // Include detachments as well as current attachments, using the log builder.
  const oldIds = ctx.db
    .all<{ subject_id: Id }>(
      `SELECT DISTINCT subject_id FROM action_log WHERE subject_kind='message'
      AND (json_extract(before,'$.card_id')=? OR json_extract(before,'$.cardId')=? OR json_extract(after,'$.cardId')=?)`,
      cardId,
      cardId,
      cardId,
    )
    .map((r) => r.subject_id)
    .filter((id) => !ids.includes(id));
  const logs = [
    ...history(ctx, { subjectKind: 'card', subjectId: cardId, limit: Number.MAX_SAFE_INTEGER }),
    ...messageLogs,
    ...oldIds.flatMap((id) => history(ctx, { subjectKind: 'message', subjectId: id, limit: Number.MAX_SAFE_INTEGER })),
  ];
  return {
    ...card,
    summary: ctx.db.get<{ summary: string }>('SELECT summary FROM card WHERE id=?', cardId)?.summary ?? '',
    messages: getMessages(ctx, { ids }).reverse(),
    history: [...new Map(logs.map((e) => [e.id, e])).values()]
      .filter((e) => {
        if (e.subjectKind === 'card' || e.redacted) return true;
        const linked = (v: unknown) =>
          v !== null &&
          typeof v === 'object' &&
          (('cardId' in v && v.cardId === cardId) || ('card_id' in v && v.card_id === cardId));
        return linked(e.before) || linked(e.after);
      })
      .sort((a, b) => b.id - a.id),
    references: cardReferencePanels(ctx, cardId),
  };
}

export function searchCards(
  ctx: Ctx,
  q: {
    laneId?: Id;
    stageId?: Id;
    companyId?: Id;
    contactId?: Id;
    text?: string;
    includeArchived?: boolean;
    limit?: number;
    offset?: number;
  },
): { cards: CardSummary[]; total: number } {
  validate(
    z.strictObject({
      laneId: IdSchema.optional(),
      stageId: IdSchema.optional(),
      companyId: IdSchema.optional(),
      contactId: IdSchema.optional(),
      text: z.string().optional(),
      includeArchived: z.boolean().optional(),
      limit: z.number().int().positive().safe().optional(),
      offset: z.number().int().nonnegative().safe().optional(),
    }),
    q,
  );
  const ids = ctx.db.all<{ id: Id }>(
    `SELECT c.id FROM card c JOIN lane l ON l.id=c.lane_id
      WHERE (? OR (c.archived_at IS NULL AND l.archived_at IS NULL))
      AND (? IS NULL OR c.lane_id=?) AND (? IS NULL OR c.stage_id=?) AND (? IS NULL OR c.company_id=?)
      AND (? IS NULL OR EXISTS (SELECT 1 FROM card_chat cc JOIN chat_participant cp ON cp.chat_id=cc.chat_id JOIN identity i ON i.id=cp.identity_id WHERE cc.card_id=c.id AND i.contact_id=?))
      AND (? IS NULL OR instr(lower(c.title),lower(?))>0 OR instr(lower(c.summary),lower(?))>0)
      ORDER BY c.last_message_at DESC,c.id DESC`,
    Number(q.includeArchived ?? false),
    q.laneId ?? null,
    q.laneId ?? null,
    q.stageId ?? null,
    q.stageId ?? null,
    q.companyId ?? null,
    q.companyId ?? null,
    q.contactId ?? null,
    q.contactId ?? null,
    q.text ?? null,
    q.text ?? null,
    q.text ?? null,
  );
  const offset = q.offset ?? 0;
  return { total: ids.length, cards: ids.slice(offset, offset + (q.limit ?? 50)).map((r) => summary(ctx, r.id)) };
}
