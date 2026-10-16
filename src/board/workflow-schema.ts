import { z } from 'zod';
import { AppError, type Ctx, IdSchema } from '../contracts/index.ts';
import { actor } from './helpers.ts';

export const workstreamSchema = z.enum(['buyer', 'provider', 'integration', 'others']);
export const workflowStageSchema = z.enum([
  'to_be_started',
  'work_in_progress',
  'integrations',
  'blocked',
  'completed',
  'archive',
]);
export const workflowTimeSchema = z.iso.datetime({ offset: true }).transform((s) => new Date(s).toISOString());
const text = z.string().trim().min(1).max(4000).nullable();
export const workflowFieldsSchema = z.strictObject({
  workstream: workstreamSchema.optional(),
  nextAction: text.optional(),
  followUpAt: workflowTimeSchema.nullable().optional(),
  blockedReason: text.optional(),
  buyerId: text.optional(),
});
export const createWorkflowSchema = z.strictObject({
  title: z.string().trim().min(1).max(500),
  summary: z.string().max(20000).optional(),
  workstream: workstreamSchema.optional(),
  nextAction: text.optional(),
  followUpAt: workflowTimeSchema.nullable().optional(),
  chatId: IdSchema.optional(),
  companyId: IdSchema.optional(),
});
export const updateWorkflowSchema = workflowFieldsSchema.extend({ version: z.number().int().positive().safe() });
export const moveWorkflowSchema = z.strictObject({
  version: z.number().int().positive().safe(),
  to: workflowStageSchema,
  reason: z.string().trim().min(1).max(4000),
  evidenceMessageIds: z.array(IdSchema).max(100).optional(),
});
export function workflowAccess(ctx: Ctx, write = false): void {
  const kind = actor(ctx);
  if (kind === 'agent') throw new AppError('forbidden', 'Explicit workflow command required');
  if (
    write &&
    kind === 'credential' &&
    !ctx.db.get(
      'SELECT id FROM credential WHERE id=? AND scope_write=1',
      ctx.actor.kind === 'credential' ? ctx.actor.id : 0,
    )
  )
    throw new AppError('forbidden', 'Workflow write scope required');
}
export const workflowStageDefinitions = [
  {
    key: 'to_be_started',
    name: 'To be started',
    criteria: 'Seeded lead or outreach only; sending outreach is not engagement.',
  },
  {
    key: 'work_in_progress',
    name: 'Work in progress',
    criteria: 'Substantive positive response, active discussion or engineering assessment.',
  },
  {
    key: 'integrations',
    name: 'Integrations',
    criteria: 'Actual tests or integration commands run; plans alone do not qualify.',
  },
  {
    key: 'blocked',
    name: 'Blocked',
    criteria: 'Explicit blocker, reason and next action or follow-up required; silence alone is not blocked.',
  },
  {
    key: 'completed',
    name: 'Completed',
    criteria:
      'Confirmed fully integrated or live usage, cited as a user/message assertion, never verified transactions from buyer ID alone.',
  },
] as const;
