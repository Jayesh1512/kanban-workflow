import { z } from 'zod';
import { CardSummarySchema } from './card-summary.ts';
import { LaneViewSchema } from './lane-view.ts';
export const BoardViewSchema = z.strictObject({
  version: z.number().int().nonnegative().safe(),
  lanes: z.array(LaneViewSchema.extend({ cards: z.array(CardSummarySchema) })),
  openReviewCount: z.number().finite(),
});
