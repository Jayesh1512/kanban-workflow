import { z } from 'zod';
import { ActionSchema } from './action.ts';
import { ConfidenceSchema } from './confidence.ts';
import { IdSchema } from './id.ts';
import { ReviewKindSchema } from './review-kind.ts';
import { ReviewProposalSchema } from './review-proposal.ts';
import { ReviewWhySchema } from './review-why.ts';
export const OutcomeSchema = z.union([
  z.strictObject({ do: z.literal('apply'), action: ActionSchema, followsHumanOverride: z.boolean() }),
  z.strictObject({
    do: z.literal('review'),
    kind: ReviewKindSchema,
    groupKey: z.string(),
    chatId: IdSchema.nullable(),
    why: ReviewWhySchema,
    proposal: ReviewProposalSchema,
    confidence: ConfidenceSchema,
  }),
  z.strictObject({ do: z.literal('pending_mention'), name: z.string().min(1), confidence: ConfidenceSchema }),
  z.strictObject({ do: z.literal('refuse'), why: z.string() }),
]);
