import { z } from 'zod';
import { IdSchema } from './id.ts';
export const CompanyRefSchema = z.union([
  z.strictObject({ id: IdSchema }),
  z.strictObject({ name: z.string().min(1) }),
]);
