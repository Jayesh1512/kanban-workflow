import { z } from 'zod';
import { IdSchema } from './id.ts';
export const MovementLaneSchema = z.strictObject({
  id: IdSchema,
  version: z.number().int().positive().safe(),
  name: z.string().min(1),
  sop: z.string(),
  stages: z.array(
    z.strictObject({
      id: IdSchema,
      name: z.string().min(1),
      position: z.number().int().nonnegative().safe(),
      criteria: z.string(),
    }),
  ),
});
