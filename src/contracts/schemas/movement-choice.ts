import { z } from 'zod';
import { ConfidenceSchema } from './confidence.ts';
export const MovementChoiceSchema = z
  .strictObject({
    choice: z.string().min(1),
    confidence: ConfidenceSchema,
    probabilities: z.record(z.string(), ConfidenceSchema),
  })
  .refine((v) => {
    const values = Object.values(v.probabilities);
    const chosen = v.probabilities[v.choice];
    return (
      values.length > 0 &&
      chosen !== undefined &&
      Math.abs(values.reduce((a, b) => a + b, 0) - 1) <= 1e-6 &&
      chosen >= Math.max(...values)
    );
  }, 'Invalid movement distribution');
