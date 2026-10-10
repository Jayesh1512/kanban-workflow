import type { Ctx, Db, Id, IsoTime, LogEntry, LogEntryInput, SubjectKind } from '../contracts/index.ts';
import { AppError, IdSchema, IsoTimeSchema, LogEntryInputSchema, SubjectKindSchema } from '../contracts/index.ts';

export type { LogEntry, LogEntryInput, SubjectKind } from '../contracts/index.ts';

export function record(ctx: Ctx, e: LogEntryInput): Id {
  if (!LogEntryInputSchema.safeParse(e).success) throw new AppError('invalid', 'Invalid action log entry');
  return ctx.db.run(
    `INSERT INTO action_log(at,actor_kind,actor_id,action,subject_kind,subject_id,before,after,reason,
      message_ids,decision_id,corrects_id,follows_human_override) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ctx.now().toISOString(),
    ctx.actor.kind,
    'id' in ctx.actor ? ctx.actor.id : null,
    e.action,
    e.subjectKind,
    e.subjectId,
    e.before === undefined ? null : JSON.stringify(e.before),
    e.after === undefined ? null : JSON.stringify(e.after),
    e.reason ?? '',
    JSON.stringify(e.messageIds ?? []),
    e.decisionId ?? null,
    e.correctsId ?? null,
    Number(e.followsHumanOverride ?? false),
  ).lastInsertRowid;
}
interface LogRow {
  id: Id;
  at: IsoTime;
  actor_kind: Ctx['actor']['kind'];
  actor_id: Id | null;
  actor_name: string;
  action: string;
  subject_kind: SubjectKind;
  subject_id: Id | null;
  before: string | null;
  after: string | null;
  reason: string;
  message_ids: string;
  decision_id: Id | null;
  corrects_id: Id | null;
  follows_human_override: number;
  redacted: number;
}
export function history(
  ctx: Ctx,
  q: {
    subjectKind?: SubjectKind;
    subjectId?: Id;
    action?: string;
    from?: IsoTime;
    to?: IsoTime;
    limit?: number;
    beforeId?: Id;
  },
): LogEntry[] {
  if (q.subjectKind !== undefined && !SubjectKindSchema.safeParse(q.subjectKind).success)
    throw new AppError('invalid', 'Invalid log subject');
  for (const id of [q.subjectId, q.beforeId])
    if (id !== undefined && !IdSchema.safeParse(id).success) throw new AppError('invalid', 'Invalid log id');
  for (const at of [q.from, q.to])
    if (at !== undefined && !IsoTimeSchema.safeParse(at).success) throw new AppError('invalid', 'Invalid log time');
  const limit = q.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new AppError('invalid', 'Invalid log limit');
  return ctx.db
    .all<LogRow>(
      `SELECT a.*, CASE a.actor_kind WHEN 'teammate' THEN t.display_name WHEN 'credential' THEN c.name ELSE a.actor_kind END AS actor_name
     FROM action_log a LEFT JOIN teammate t ON a.actor_kind='teammate' AND t.id=a.actor_id
     LEFT JOIN credential c ON a.actor_kind='credential' AND c.id=a.actor_id
     WHERE (? IS NULL OR a.subject_kind=?) AND (? IS NULL OR a.subject_id=?)
       AND (? IS NULL OR a.action=?) AND (? IS NULL OR a.at>=?) AND (? IS NULL OR a.at<=?)
       AND (? IS NULL OR a.id<?) ORDER BY a.id DESC LIMIT ?`,
      q.subjectKind ?? null,
      q.subjectKind ?? null,
      q.subjectId ?? null,
      q.subjectId ?? null,
      q.action ?? null,
      q.action ?? null,
      q.from ?? null,
      q.from ?? null,
      q.to ?? null,
      q.to ?? null,
      q.beforeId ?? null,
      q.beforeId ?? null,
      limit,
    )
    .map((row) => ({
      id: row.id,
      at: row.at,
      actor: { kind: row.actor_kind, id: row.actor_id, name: row.actor_name ?? row.actor_kind },
      action: row.action,
      subjectKind: row.subject_kind,
      subjectId: row.subject_id,
      before: row.before === null ? null : (JSON.parse(row.before) as unknown),
      after: row.after === null ? null : (JSON.parse(row.after) as unknown),
      reason: row.reason,
      messageIds: JSON.parse(row.message_ids) as Id[],
      correctsId: row.corrects_id,
      followsHumanOverride: Boolean(row.follows_human_override),
      redacted: Boolean(row.redacted),
    }));
}
export function boardVersion(db: Db): number {
  return db.get<{ version: number }>('SELECT coalesce(max(id),0) AS version FROM action_log')?.version ?? 0;
}
export function redact(
  ctx: Ctx,
  sel: { messageIds: Id[]; decisionIds: Id[]; cardIds: Id[]; reviewItemIds: Id[]; contactIds: Id[]; companyIds: Id[] },
): number {
  for (const ids of Object.values(sel))
    if (ids.some((id) => !IdSchema.safeParse(id).success)) throw new AppError('invalid', 'Invalid redaction id');
  return ctx.db.tx(() => {
    const subjects: Partial<Record<SubjectKind, Id[]>> = {
      card: sel.cardIds,
      review: sel.reviewItemIds,
      contact: sel.contactIds,
      company: sel.companyIds,
    };
    const rows = ctx.db.all<Pick<LogRow, 'id' | 'subject_kind' | 'subject_id' | 'message_ids' | 'decision_id'>>(
      'SELECT id,subject_kind,subject_id,message_ids,decision_id FROM action_log WHERE redacted=0',
    );
    let count = 0;
    for (const row of rows) {
      const messages: unknown = JSON.parse(row.message_ids);
      if (!Array.isArray(messages)) throw new AppError('invalid', 'Invalid log message ids');
      if (
        messages.some((id) => typeof id === 'number' && sel.messageIds.includes(id)) ||
        (row.decision_id !== null && sel.decisionIds.includes(row.decision_id)) ||
        (row.subject_id !== null && subjects[row.subject_kind]?.includes(row.subject_id))
      ) {
        count += ctx.db.run(
          "UPDATE action_log SET redacted=1,before=NULL,after=NULL,reason='',message_ids='[]' WHERE id=?",
          row.id,
        ).changes;
      }
    }
    return count;
  });
}
