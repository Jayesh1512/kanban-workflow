import { z } from 'zod';
import { IdSchema } from './id.ts';
export const ContactSummarySchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1),
  companies: z.array(z.strictObject({ id: IdSchema, name: z.string().min(1) })),
  roleCategory: z.string(),
  dealsAbout: z.string(),
});
