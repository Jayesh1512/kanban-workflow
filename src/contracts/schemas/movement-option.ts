import { z } from 'zod';
import { IdSchema } from './id.ts';
export const MovementOptionSchema = z.strictObject({
  id: z.string(),
  toLaneId: IdSchema,
  toStageId: IdSchema,
  laneVersion: z.number().int().positive().safe(),
  criterionId: z.string(),
  criterionLabel: z.string(),
});
