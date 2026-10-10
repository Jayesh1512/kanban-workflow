import { z } from 'zod';
import { IdSchema } from './id.ts';
export const MovementEvidenceOptionSchema = z.strictObject({
  id: z.string().min(1),
  messageIds: z
    .array(IdSchema)
    .min(1)
    .refine((v) => new Set(v).size === v.length),
});
