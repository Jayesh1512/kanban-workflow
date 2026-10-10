import { z } from 'zod';
import { IdSchema } from './id.ts';
export const CompanyMatchSchema = z.strictObject({
  match: z.union([z.literal('exact'), z.literal('alias'), z.literal('similar'), z.literal('none')]),
  companyId: IdSchema.nullable(),
  score: z.number().finite(),
});
