import { z } from 'zod';
import { IdSchema } from './id.ts';
import { IsoTimeSchema } from './iso-time.ts';
export const MovementEvidenceSchema = z.strictObject({
  id: IdSchema,
  key: z.string().min(1),
  version: z.number().int().positive().safe(),
  sentAt: IsoTimeSchema,
  text: z.string(),
  media: z.string().nullable(),
  replyToId: IdSchema.nullable(),
});
