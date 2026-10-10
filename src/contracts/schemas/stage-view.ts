import { z } from 'zod';
import { IdSchema } from './id.ts';
export const StageViewSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1),
  position: z.number().int().nonnegative().safe(),
  criteria: z.string(),
});
