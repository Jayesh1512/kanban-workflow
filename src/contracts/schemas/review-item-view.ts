import { z } from 'zod';
import { ConfidenceSchema } from './confidence.ts';
import { IdSchema } from './id.ts';
import { IsoTimeSchema } from './iso-time.ts';
import { MessageViewSchema } from './message-view.ts';
import { ReviewKindSchema } from './review-kind.ts';
import { ReviewProposalSchema } from './review-proposal.ts';
import { ReviewWhySchema } from './review-why.ts';
export const ReviewItemViewSchema = z.strictObject({
  id: IdSchema,
  kind: ReviewKindSchema,
  why: ReviewWhySchema,
  confidence: ConfidenceSchema,
  reason: z.string(),
  createdAt: IsoTimeSchema,
  updatedAt: IsoTimeSchema,
  chat: z.strictObject({ id: IdSchema, title: z.string() }).nullable(),
  proposal: ReviewProposalSchema,
  describe: z.string(),
  messages: z.array(MessageViewSchema),
  canAccept: z.boolean(),
  allowedChanges: z.array(z.enum(['new_card', 'card', 'stage', 'company', 'role'])),
});
