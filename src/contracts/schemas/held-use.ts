import { z } from 'zod';
import { IdSchema } from './id.ts';
export const HeldUseSchema = z.union([
  z.strictObject({ use: z.literal('contact_company'), contactId: IdSchema, evidenceMessageIds: z.array(IdSchema) }),
  z.strictObject({ use: z.literal('reference'), messageId: IdSchema }),
]);
