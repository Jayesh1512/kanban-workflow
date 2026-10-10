import { z } from 'zod';
import { IdSchema } from './id.ts';
export const MovementEvidenceOptionSchema = z.strictObject({ id: z.string(), messageIds: z.array(IdSchema) });
