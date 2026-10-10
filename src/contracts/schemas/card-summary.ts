import { z } from 'zod';
import { IdSchema } from './id.ts';
import { IsoTimeSchema } from './iso-time.ts';
export const CardSummarySchema = z.strictObject({
  id: IdSchema,
  laneId: IdSchema,
  stageId: IdSchema,
  title: z.string(),
  company: z.strictObject({ id: IdSchema, name: z.string().min(1) }).nullable(),
  contacts: z.array(z.strictObject({ id: IdSchema, name: z.string().min(1) })),
  teammates: z.array(z.strictObject({ id: IdSchema, name: z.string().min(1) })),
  lastMessageAt: IsoTimeSchema.nullable(),
  lastChangeBy: z.union([z.literal('agent'), z.literal('teammate'), z.literal('credential')]),
  fromHistory: z.boolean(),
  archived: z.boolean(),
  hasGap: z.boolean(),
});
