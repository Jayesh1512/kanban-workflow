import { z } from 'zod';
import { ConfidenceSchema } from './confidence.ts';
import { ModelDecisionSchema } from './model-decision.ts';
export const ScriptDecisionSchema = z.strictObject({
  disposition: ModelDecisionSchema.shape.disposition,
  card: z.string().nullable(),
  proposal: z.string().nullable(),
  lane: z.string().nullable(),
  title: z.string().min(1).max(80).nullable(),
  summary: z.string().max(400).nullable(),
  cardCompany: z.string().nullable(),
  confidence: ConfidenceSchema,
  reason: z.string().min(1).max(300),
  move: z
    .strictObject({
      toStage: z.string().min(1),
      criterion: z.string().min(1),
      evidenceMessageKeys: z.array(z.string()),
      confidence: ConfidenceSchema,
    })
    .nullable(),
  contacts: z.array(
    z.strictObject({
      userKey: z.string().min(1),
      company: z.string().nullable(),
      companyConfidence: ConfidenceSchema,
      roleCategory: z.string().nullable(),
      dealsAbout: z.string().nullable(),
      roleConfidence: ConfidenceSchema,
      evidenceMessageKeys: z.array(z.string()),
    }),
  ),
  mentions: z.array(z.strictObject({ company: z.string(), confidence: ConfidenceSchema })),
});
