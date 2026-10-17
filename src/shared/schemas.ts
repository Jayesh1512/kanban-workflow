import { z } from 'zod';
import { LANES, WORKSTREAMS } from './domain.js';

export const uuidSchema = z.uuid();
export const chatIdSchema = z.string().regex(/^-?[1-9]\d*$/);
export const remoteIdSchema = z.string().regex(/^[1-9]\d*$/);
export const timestampSchema = z.iso.datetime({ offset: true });
export const laneSchema = z.enum(LANES);
export const workstreamSchema = z.enum(WORKSTREAMS);
export const idempotencyKeySchema = z.string().min(1).max(200);
export const pageInputSchema = z.strictObject({ cursor: z.string().max(500).optional(), limit: z.number().int().min(1).max(200).optional() });
export const proposeLaneSchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
  ticketId: uuidSchema,
  expectedStageVersion: z.number().int().nonnegative(),
  targetLane: laneSchema,
  evidenceIds: z.array(uuidSchema).min(1),
  reason: z.string().min(1).max(8000),
  nextAction: z.string().max(4000).nullable(),
  origin: z.enum(['jev', 'openai', 'hermes', 'manual']),
});
export type ProposeLaneInput = z.infer<typeof proposeLaneSchema>;
export const decideProposalSchema = z.discriminatedUnion('decision', [
  z.strictObject({ idempotencyKey: idempotencyKeySchema, proposalId: uuidSchema, decision: z.enum(['approve', 'reject']), note: z.string().max(4000).optional() }),
  z.strictObject({ idempotencyKey: idempotencyKeySchema, proposalId: uuidSchema, decision: z.literal('correct'), targetLane: laneSchema, reason: z.string().min(1).max(8000), evidenceIds: z.array(uuidSchema).min(1) }),
]);
export type DecideProposalInput = z.infer<typeof decideProposalSchema>;
export const setInclusionSchema = z.strictObject({ idempotencyKey: idempotencyKeySchema, chatId: chatIdSchema, inclusion: z.enum(['included', 'excluded']), expectedPolicyVersion: z.number().int().nonnegative() });
export type SetInclusionInput = z.infer<typeof setInclusionSchema>;
export const correctMappingSchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema, chatId: chatIdSchema, expectedMappingVersion: z.number().int().nonnegative(),
  companyId: uuidSchema.nullable(), status: z.enum(['confirmed', 'non_company', 'unresolved']), evidenceIds: z.array(uuidSchema),
  reason: z.string().min(1).max(4000), source: z.enum(['http', 'mcp', 'telegram']),
}).superRefine((v, ctx) => { if ((v.status === 'confirmed') !== (v.companyId !== null)) ctx.addIssue({ code: 'custom', message: 'Only confirmed mapping must name a company' }); });
export type CorrectMappingInput = z.infer<typeof correctMappingSchema>;
export const updateActionsSchema = z.strictObject({ idempotencyKey: idempotencyKeySchema, ticketId: uuidSchema, expectedActionsVersion: z.number().int().nonnegative(), nextAction: z.string().max(4000).nullable(), followUpAt: timestampSchema.nullable(), etaAt: timestampSchema.nullable(), evidenceIds: z.array(uuidSchema) });
export type UpdateActionsInput = z.infer<typeof updateActionsSchema>;
export const dateFactSchema = z.strictObject({
  kind: z.enum(['commitment', 'follow_up', 'eta']), originalText: z.string().min(1),
  relativeTo: timestampSchema, timezone: z.string().min(1), resolvedAt: timestampSchema.nullable(),
  localDate: z.iso.date().nullable(), precision: z.enum(['instant', 'date', 'unresolved']),
  ambiguous: z.boolean(), evidenceIds: z.array(uuidSchema),
}).superRefine((v, ctx) => {
  const valid = v.precision === 'instant' ? v.resolvedAt !== null && v.localDate === null
    : v.precision === 'date' ? v.localDate !== null && v.resolvedAt === null
      : v.localDate === null && v.resolvedAt === null;
  if (!valid) ctx.addIssue({ code: 'custom', message: 'Date precision and resolved fields disagree' });
});
export const updateFactSchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema, factId: uuidSchema, expectedVersion: z.number().int().nonnegative(),
  state: z.enum(['open', 'answered', 'completed', 'withdrawn']),
  actor: z.strictObject({ party: z.enum(['antseed', 'external', 'unknown']), contactId: uuidSchema.nullable(), displayName: z.string().nullable() }),
  evidenceIds: z.array(uuidSchema), answersFactId: uuidSchema.nullable(),
  dates: z.array(dateFactSchema),
});
export type UpdateFactInput = z.infer<typeof updateFactSchema>;
