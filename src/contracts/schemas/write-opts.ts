import { z } from 'zod';
import { IdSchema } from './id.ts';
import { SetBySchema } from './set-by.ts';
export const WriteOptsSchema = z.strictObject({
  reason: z.string().optional(),
  decisionId: IdSchema.nullable().optional(),
  setBy: SetBySchema.optional(),
  correctsLogId: IdSchema.optional(),
});
