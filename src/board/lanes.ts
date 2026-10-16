import { z } from 'zod';
import type { Ctx, Id, LaneView } from '../contracts/index.ts';
import { AppError, IdSchema } from '../contracts/index.ts';
import { record } from '../log/index.ts';
import { actor, lane, validate } from './helpers.ts';
import { validateWorkflowStageEdit } from './workflow-stages.ts';

export function createLane(
  ctx: Ctx,
  i: { name: string; sop: string; stages: { name: string; criteria: string }[] },
): LaneView {
  if (ctx.actor.kind === 'agent') throw new AppError('forbidden', 'Human required');
  actor(ctx);
  i = validate(
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

export function listLanes(ctx: Ctx, o?: { includeArchived?: boolean }): LaneView[] {
  validate(z.strictObject({ includeArchived: z.boolean().optional() }), o ?? {});
  return ctx.db
    .all<{ id: Id }>(
      'SELECT id FROM lane WHERE (? OR archived_at IS NULL) ORDER BY position,id',
      Number(o?.includeArchived ?? false),
    )
    .map((r) => lane(ctx, r.id));
}

export function updateLane(
  ctx: Ctx,
  laneId: Id,
  i: { name?: string; sop?: string; stages?: { id?: Id; name: string; criteria: string }[] },
): LaneView {
  if (ctx.actor.kind === 'agent') throw new AppError('forbidden', 'Human required');
  actor(ctx);
  validate(IdSchema, laneId);
  i = validate(
    z.strictObject({
      name: z.string().trim().min(1).optional(),
      sop: z.string().trim().min(1).optional(),
      stages: z
        .array(z.strictObject({ id: IdSchema.optional(), name: z.string().trim().min(1), criteria: z.string() }))
        .min(2)
        .optional(),
    }),
    i,
  );
  if (i.stages && new Set(i.stages.map((s) => s.name)).size !== i.stages.length)
    throw new AppError('invalid', 'Duplicate stage names');
  return ctx.db.tx(() => {
    const before = lane(ctx, laneId);
    if (i.name !== undefined && ctx.db.get('SELECT id FROM lane WHERE name=? AND id<>?', i.name, laneId))
      throw new AppError('conflict', 'Lane name exists');
    if (i.stages) {
      validateWorkflowStageEdit(ctx, laneId, i.stages);
      const ids = i.stages.flatMap((s) => (s.id === undefined ? [] : [s.id]));
      if (new Set(ids).size !== ids.length) throw new AppError('invalid', 'Duplicate stage ids');
      for (const id of ids)
        if (!before.stages.some((s) => s.id === id)) throw new AppError('invalid', 'Stage is not active in this lane');
      const removed = before.stages.filter((s) => !ids.includes(s.id));
      for (const s of removed)
        if (ctx.db.get('SELECT id FROM card WHERE stage_id=?', s.id))
          throw new AppError('conflict', 'Stage holds cards');
      // Names may be swapped, or a previously removed name reused. Move all
      // existing names aside transactionally before installing the full list.
      const all = ctx.db.all<{ id: Id; name: string }>('SELECT id,name FROM stage WHERE lane_id=?', laneId);
      for (const s of all) {
        let name = `removed-stage-${s.id}`;
        while (all.some((r) => r.name === name) || i.stages.some((r) => r.name === name)) name += '-';
        ctx.db.run('UPDATE stage SET name=? WHERE id=?', name, s.id);
      }
      for (const s of removed) ctx.db.run('UPDATE stage SET removed_at=? WHERE id=?', ctx.now().toISOString(), s.id);
      for (const [position, s] of i.stages.entries()) {
        if (s.id === undefined)
          ctx.db.run(
            'INSERT INTO stage(lane_id,name,position,criteria) VALUES (?,?,?,?)',
            laneId,
            s.name,
            position,
            s.criteria,
          );
        else ctx.db.run('UPDATE stage SET name=?,position=?,criteria=? WHERE id=?', s.name, position, s.criteria, s.id);
      }
    }
    ctx.db.run(
      'UPDATE lane SET name=?,sop=?,version=version+1 WHERE id=?',
      i.name ?? before.name,
      i.sop ?? before.sop,
      laneId,
    );
    const after = lane(ctx, laneId);
    record(ctx, { action: 'lane.update', subjectKind: 'lane', subjectId: laneId, before, after });
    return after;
  });
}

export function archiveLane(ctx: Ctx, laneId: Id): void {
  if (ctx.actor.kind === 'agent') throw new AppError('forbidden', 'Human required');
  actor(ctx);
  validate(IdSchema, laneId);
  ctx.db.tx(() => {
    const before = lane(ctx, laneId);
    if (before.archived) return;
    ctx.db.run('UPDATE lane SET archived_at=?,version=version+1 WHERE id=?', ctx.now().toISOString(), laneId);
    record(ctx, { action: 'lane.archive', subjectKind: 'lane', subjectId: laneId, before, after: lane(ctx, laneId) });
  });
}
