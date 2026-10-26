import { z } from 'zod';
import { uuidSchema } from './schemas.js';
export const salesStageSchema = z.enum(['lead', 'qualification', 'negotiation', 'won', 'archived']);
export const outreachListSchema = z.strictObject({
    cursor: uuidSchema.optional(), limit: z.number().int().min(1).max(100).default(50),
    query: z.string().trim().max(200).optional(), stage: salesStageSchema.optional(),
    disposition: z.enum(['pipeline', 'context_review']).optional(),
});
export const outreachGetSchema = z.strictObject({ id: uuidSchema });
export const salesProposalSchema = z.strictObject({
    relationshipId: uuidSchema, idempotencyKey: z.string().trim().min(1).max(200),
    expectedEvidenceRevision: z.number().int().nonnegative(), targetStage: salesStageSchema,
    reason: z.string().trim().min(1).max(4000), restoreNative: z.boolean().default(false),
});
export const salesDecisionSchema = z.strictObject({
    proposalId: uuidSchema, idempotencyKey: z.string().trim().min(1).max(200),
    action: z.enum(['approve', 'reject', 'correct']), reason: z.string().trim().min(1).max(4000),
    correctedStage: salesStageSchema.optional(),
}).refine(v => (v.action === 'correct') === (v.correctedStage !== undefined), 'A correction requires a separate replacement stage');
export const salesProposalListSchema = z.strictObject({ relationshipId: uuidSchema.optional(), limit: z.number().int().min(1).max(100).default(50) });
export const salesAssessmentSchema = z.strictObject({ relationshipId: uuidSchema, expectedEvidenceRevision: z.number().int().nonnegative(), retry: z.boolean().default(false) });
const reportContact = z.strictObject({ name: z.string().trim().min(1).max(300), role: z.string().max(300).default(''), email: z.email().optional() });
export const emailReportSchema = z.strictObject({
    namespace: z.string().trim().min(1).max(200), checkedAt: z.iso.datetime({ offset: true }),
    coverage: z.string().trim().min(1).max(4000), threads: z.array(z.strictObject({
        key: z.string().trim().min(1).max(300), companyName: z.string().trim().min(1).max(500), companyId: uuidSchema.optional(),
        title: z.string().trim().min(1).max(500), summary: z.string().trim().min(1).max(12000),
        sourceUrl: z.url().refine(v => new URL(v).protocol === 'https:').optional(), sourceAt: z.iso.datetime({ offset: true }).nullable(),
        contacts: z.array(reportContact).max(100), provisionalStage: salesStageSchema.nullable(),
        nextAction: z.string().max(2000), claims: z.array(z.string().trim().min(1).max(4000)).min(1).max(100),
    })).min(1).max(200),
}).refine(v => new Set(v.threads.map(t => t.key)).size === v.threads.length, 'Duplicate thread identifiers');
export const importCommitSchema = z.strictObject({ id: uuidSchema });
export const outreachActionsSchema = z.strictObject({
    relationshipId: uuidSchema, expectedActionsVersion: z.number().int().nonnegative(),
    actions: z.array(z.strictObject({ text: z.string().trim().min(1).max(2000), actor: z.enum(['antseed', 'external', 'unknown']), state: z.enum(['open', 'completed', 'cancelled']),
        precision: z.enum(['none', 'date', 'instant']), localDate: z.iso.date().nullable(), instant: z.iso.datetime({ offset: true }).nullable(), timezone: z.string().refine(v => {
            try {
                new Intl.DateTimeFormat('en', { timeZone: v });
                return true;
            }
            catch {
                return false;
            }
        })
    }).refine(v => v.precision === 'none' ? v.localDate === null && v.instant === null : v.precision === 'date' ? v.localDate !== null && v.instant === null : v.instant !== null && v.localDate === null, 'Invalid deadline precision')).max(100),
});
export const outreachIdentitySchema = z.strictObject({ relationshipId: uuidSchema, expectedIdentityVersion: z.number().int().nonnegative(), displayName: z.string().trim().min(1).max(500), reason: z.string().trim().min(1).max(4000) });
