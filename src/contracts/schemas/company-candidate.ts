import { z } from 'zod';
import { IdSchema } from './id.ts';
export const CompanyCandidateSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1),
  aliases: z.array(z.string()),
  why: z.union([z.literal('participant'), z.literal('named'), z.literal('card'), z.literal('text')]),
});
