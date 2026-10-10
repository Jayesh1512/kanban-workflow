import type { z } from 'zod';
import type { CardSummary, Ctx, Id, LaneView, SetBy, WriteOpts } from '../contracts/index.ts';
import { AppError, WriteOptsSchema } from '../contracts/index.ts';

export function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const p = schema.safeParse(value);
  if (!p.success) throw new AppError('invalid', 'Invalid board input');
  return p.data;
}
export function actor(ctx: Ctx): 'agent' | 'teammate' | 'credential' {
  if (ctx.actor.kind === 'system') throw new AppError('forbidden', 'Board actor required');
  if (
    ctx.actor.kind === 'teammate' &&
    !ctx.db.get('SELECT id FROM teammate WHERE id=? AND removed_at IS NULL', ctx.actor.id)
  )
    throw new AppError('forbidden', 'Active teammate required');
  if (
    ctx.actor.kind === 'credential' &&
    !ctx.db.get(
      'SELECT c.id FROM credential c JOIN teammate t ON t.id=c.created_by WHERE c.id=? AND c.revoked_at IS NULL AND t.removed_at IS NULL',
      ctx.actor.id,
    )
  )
    throw new AppError('forbidden', 'Active credential required');
  return ctx.actor.kind;
}
export function setBy(ctx: Ctx, o?: WriteOpts): SetBy {
  const kind = actor(ctx);
  if (o) validate(WriteOptsSchema, o);
  const value = o?.setBy ?? (kind === 'agent' ? 'agent' : 'human');
  if (ctx.actor.kind === 'agent' && value === 'human') throw new AppError('forbidden', 'Agent cannot set human values');
  return value;
}
export function lane(ctx: Ctx, id: Id): LaneView {
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
export function summary(ctx: Ctx, id: Id): CardSummary {
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
