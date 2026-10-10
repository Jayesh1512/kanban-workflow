import { z } from 'zod';
import { CompanyRefSchema } from './company-ref.ts';
import { HeldUseSchema } from './held-use.ts';
import { IdSchema } from './id.ts';
export const ReviewProposalSchema = z.union([
  z.strictObject({
    kind: z.literal('new_card'),
    laneId: IdSchema,
    title: z.string().min(1).max(80),
    summary: z.string().max(400),
    companyId: IdSchema.nullable(),
    move: z.strictObject({ toStageId: IdSchema, criterion: z.string().min(1) }).nullable(),
  }),
  z.strictObject({ kind: z.literal('attach'), cardId: IdSchema, summary: z.string().max(400).nullable() }),
  z.strictObject({ kind: z.literal('move'), cardId: IdSchema, toStageId: IdSchema, criterion: z.string().min(1) }),
  z.strictObject({ kind: z.literal('is_work') }),
  z.strictObject({ kind: z.literal('contact_company'), contactId: IdSchema, company: CompanyRefSchema }),
  z.strictObject({
    kind: z.literal('contact_role'),
    contactId: IdSchema,
    category: z.string(),
    dealsAbout: z.string(),
  }),
  z.strictObject({
    kind: z.literal('name_company'),
    name: z.string().min(1),
    companyId: IdSchema,
    held: z.array(HeldUseSchema),
  }),
  z.strictObject({ kind: z.literal('model_failed') }),
]);
