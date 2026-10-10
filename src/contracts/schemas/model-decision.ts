import { z } from 'zod';
import { ConfidenceSchema } from './confidence.ts';
import { IdSchema } from './id.ts';
export const ModelDecisionSchema = z.strictObject({
  disposition: z.union([z.literal('none'), z.literal('attach'), z.literal('create'), z.literal('join')]),
  cardId: IdSchema.nullable(),
  proposalId: IdSchema.nullable(),
  laneId: IdSchema.nullable(),
  title: z.string().min(1).max(80).nullable(),
  summary: z.string().max(400).nullable(),
  cardCompanyId: IdSchema.nullable(),
  cardCompanyName: z.string().nullable(),
  confidence: ConfidenceSchema,
  reason: z.string().min(1).max(300),
  move: z
    .strictObject({
      toStageId: IdSchema,
      criterion: z.string().min(1),
      evidenceMessageIds: z.array(IdSchema),
      confidence: ConfidenceSchema,
    })
    .nullable(),
  contacts: z.array(
    z.strictObject({
      contactId: IdSchema,
      companyId: IdSchema.nullable(),
      companyName: z.string().nullable(),
      companyConfidence: ConfidenceSchema,
      roleCategory: z.string().nullable(),
      dealsAbout: z.string().nullable(),
      roleConfidence: ConfidenceSchema,
      evidenceMessageIds: z.array(IdSchema),
    }),
  ),
  mentions: z.array(
    z.strictObject({ companyId: IdSchema.nullable(), name: z.string().min(1), confidence: ConfidenceSchema }),
  ),
});
