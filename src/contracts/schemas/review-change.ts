import { z } from 'zod';
import { IdSchema } from './id.ts';
export const ReviewChangeSchema = z.union([
  z.strictObject({
    to: z.literal('new_card'),
    laneId: IdSchema,
    title: z.string(),
    summary: z.string(),
    stageId: IdSchema.nullable(),
  }),
  z.strictObject({ to: z.literal('card'), cardId: IdSchema }),
  z.strictObject({ to: z.literal('stage'), stageId: IdSchema }),
  z.strictObject({ to: z.literal('company'), company: z.string() }),
  z.strictObject({ to: z.literal('role'), category: z.string(), dealsAbout: z.string() }),
]);
