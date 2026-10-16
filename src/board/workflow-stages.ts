import type { Ctx, Id } from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';
import { workflowStageDefinitions } from './workflow-schema.ts';

/** Generic lane order is presentation; configured workflow defaults have a stable meaning. */
export function workflowInitialStage(ctx: Ctx, laneId: Id): Id | null {
  if (!ctx.db.get('SELECT id FROM workflow_config WHERE lane_id=?', laneId)) return null;
  const first = ctx.db.get<{ id: Id }>(
    "SELECT s.id FROM workflow_stage w JOIN stage s ON s.id=w.stage_id JOIN lane l ON l.id=s.lane_id WHERE w.key='to_be_started' AND s.lane_id=? AND s.removed_at IS NULL AND l.archived_at IS NULL",
    laneId,
  );
  if (!first) throw new AppError('conflict', 'Workflow initial stage is unavailable');
  return first.id;
}
export function validateWorkflowStageEdit(
  ctx: Ctx,
  laneId: Id,
  stages: { id?: Id; name: string; criteria: string }[],
): void {
  if (!ctx.db.get('SELECT id FROM workflow_config WHERE lane_id=?', laneId)) return;
  const mapped = ctx.db.all<{ key: string; stage_id: Id }>(
    'SELECT w.key,w.stage_id FROM workflow_stage w JOIN stage s ON s.id=w.stage_id WHERE s.lane_id=? AND s.removed_at IS NULL',
    laneId,
  );
  if (
    mapped.length !== workflowStageDefinitions.length ||
    stages.length !== mapped.length ||
    workflowStageDefinitions.some((definition) => {
      const id = mapped.find((m) => m.key === definition.key)?.stage_id;
      const proposed = stages.find((s) => s.id === id);
      return !id || !proposed || proposed.name !== definition.name || proposed.criteria !== definition.criteria;
    })
  )
    throw new AppError(
      'invalid',
      'Configured workflow stage identities, names and criteria must remain intact; ordering may change',
    );
}
