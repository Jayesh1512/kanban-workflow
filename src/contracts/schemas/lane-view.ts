import { z } from 'zod';
import { IdSchema } from './id.ts';
import { StageViewSchema } from './stage-view.ts';
export const LaneViewSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1),
  sop: z.string(),
  version: z.number().int().positive().safe(),
  position: z.number().int().nonnegative().safe(),
  archived: z.boolean(),
  stages: z.array(StageViewSchema),
});
