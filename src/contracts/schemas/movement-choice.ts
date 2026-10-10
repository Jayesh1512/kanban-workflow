import { z } from 'zod';
import { ConfidenceSchema } from './confidence.ts';
export const MovementChoiceSchema = z.strictObject({
  choice: z.string(),
  confidence: ConfidenceSchema,
  probabilities: z.record(z.string(), ConfidenceSchema),
});
