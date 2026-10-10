import { z } from 'zod';
import type { BoardView, CardSummary, Ctx, Id, LaneView, SetBy, WriteOpts } from '../contracts/index.ts';
import { AppError, IdSchema, WriteOptsSchema } from '../contracts/index.ts';
import { boardVersion, record } from '../log/index.ts';

function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const p = schema.safeParse(value);
  if (!p.success) throw new AppError('invalid', 'Invalid board input');
  return p.data;
}
function actor(ctx: Ctx): 'agent' | 'teammate' | 'credential' {
  if (ctx.actor.kind === 'system') throw new AppError('forbidden', 'Board actor required');
  return ctx.actor.kind;
}
function setBy(ctx: Ctx, o?: WriteOpts): SetBy {
  if (o) validate(WriteOptsSchema, o);
  const value = o?.setBy ?? (actor(ctx) === 'agent' ? 'agent' : 'human');
  if (ctx.actor.kind === 'agent' && value === 'human') throw new AppError('forbidden', 'Agent cannot set human values');
  return value;
}
function lane(ctx: Ctx, id: Id): LaneView {
  const r = ctx.db.get<{
    id: Id;
    name: string;
    sop: string;
    version: number;
    position: number;
    archived_at: string | null;
  }>('SELECT * FROM lane WHERE id=?', id);
  if (!r) throw new AppError('not_found', 'Lane not found');
  return {
    id: r.id,
    name: r.name,
    sop: r.sop,
    version: r.version,
    position: r.position,
    archived: r.archived_at !== null,
    stages: ctx.db.all(
      'SELECT id,name,position,criteria FROM stage WHERE lane_id=? AND removed_at IS NULL ORDER BY position',
      id,
    ),
  };
}
function summary(ctx: Ctx, id: Id): CardSummary {
  const r = ctx.db.get<{
    id: Id;
    lane_id: Id;
    stage_id: Id;
    title: string;
    company_id: Id | null;
    company_name: string | null;
    last_message_at: string | null;
    last_change_by_kind: CardSummary['lastChangeBy'];
    from_history: number;
    archived_at: string | null;
  }>('SELECT c.*,co.name AS company_name FROM card c LEFT JOIN company co ON co.id=c.company_id WHERE c.id=?', id);
  if (!r) throw new AppError('not_found', 'Card not found');
  const contacts = ctx.db.all<{ id: Id; name: string }>(
    'SELECT DISTINCT co.id,co.display_name AS name FROM card_chat cc JOIN chat_participant cp ON cp.chat_id=cc.chat_id JOIN identity i ON i.id=cp.identity_id JOIN contact co ON co.id=i.contact_id WHERE cc.card_id=? ORDER BY co.id',
    id,
  );
  const teammates = ctx.db.all<{ id: Id; name: string }>(
    'SELECT DISTINCT t.id,t.display_name AS name FROM card_chat cc JOIN account_chat ac ON ac.chat_id=cc.chat_id JOIN channel_account a ON a.id=ac.account_id JOIN teammate t ON t.id=a.teammate_id WHERE cc.card_id=? ORDER BY t.id',
    id,
  );
  const hasGap = Boolean(
    ctx.db.get(
      'SELECT g.id FROM chat_gap g JOIN card_chat cc ON cc.chat_id=g.chat_id WHERE cc.card_id=? AND g.closed_at IS NULL LIMIT 1',
      id,
    ),
  );
  return {
    id: r.id,
    laneId: r.lane_id,
    stageId: r.stage_id,
    title: r.title,
    company: r.company_id === null ? null : { id: r.company_id, name: r.company_name as string },
    contacts,
    teammates,
    lastMessageAt: r.last_message_at,
    lastChangeBy: r.last_change_by_kind,
    fromHistory: Boolean(r.from_history),
    archived: r.archived_at !== null,
    hasGap,
  };
}
export function createLane(
  ctx: Ctx,
  i: { name: string; sop: string; stages: { name: string; criteria: string }[] },
): LaneView {
  if (ctx.actor.kind === 'agent') throw new AppError('forbidden', 'Human required');
  actor(ctx);
  validate(
    z.strictObject({
      name: z.string().trim().min(1),
      sop: z.string().trim().min(1),
      stages: z.array(z.strictObject({ name: z.string().trim().min(1), criteria: z.string() })).min(2),
    }),
    i,
  );
  if (new Set(i.stages.map((s) => s.name)).size !== i.stages.length)
    throw new AppError('invalid', 'Duplicate stage names');
  return ctx.db.tx(() => {
    if (ctx.db.get('SELECT id FROM lane WHERE name=?', i.name)) throw new AppError('conflict', 'Lane name exists');
    const position = ctx.db.get<{ n: number }>('SELECT coalesce(max(position)+1,0) AS n FROM lane')?.n ?? 0;
    const id = ctx.db.run(
      'INSERT INTO lane(name,sop,position,created_at) VALUES (?,?,?,?)',
      i.name,
      i.sop,
      position,
      ctx.now().toISOString(),
    ).lastInsertRowid;
    i.stages.forEach((s, p) => {
      ctx.db.run('INSERT INTO stage(lane_id,name,position,criteria) VALUES (?,?,?,?)', id, s.name, p, s.criteria);
    });
    const view = lane(ctx, id);
    record(ctx, { action: 'lane.create', subjectKind: 'lane', subjectId: id, after: view });
    return view;
  });
}
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
    const stage = l.stages.find((s) => s.id === (i.stageId ?? l.stages[0]?.id));
    if (!stage) throw new AppError('invalid', 'Stage is not in lane');
    if (i.companyId != null && !ctx.db.get('SELECT id FROM company WHERE id=?', i.companyId))
      throw new AppError('not_found', 'Company not found');
    const m =
      i.messageId === undefined
        ? undefined
        : ctx.db.get<{ chat_id: Id; sent_at: string }>('SELECT chat_id,sent_at FROM message WHERE id=?', i.messageId);
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
    const target = ctx.db.get<{ lane_id: Id }>(
      'SELECT s.lane_id FROM stage s JOIN lane l ON l.id=s.lane_id WHERE s.id=? AND s.removed_at IS NULL AND l.archived_at IS NULL',
      i.stageId,
    );
    if (!target) throw new AppError('invalid', 'Inactive stage');
    if (ctx.actor.kind === 'agent' && target.lane_id !== before.laneId)
      throw new AppError('forbidden', 'Cross-lane move requires human');
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
    const m = ctx.db.get<{ chat_id: Id; sent_at: string }>('SELECT chat_id,sent_at FROM message WHERE id=?', messageId);
    if (!m) throw new AppError('not_found', 'Message not found');
    const before = ctx.db.get<{ card_id: Id | null; set_by: SetBy }>(
      'SELECT card_id,set_by FROM card_message WHERE message_id=?',
      messageId,
    );
    if (ctx.actor.kind === 'agent' && before?.set_by === 'human')
      throw new AppError('forbidden', 'Human attachment is locked');
    if (cardId !== null) {
      summary(ctx, cardId);
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
