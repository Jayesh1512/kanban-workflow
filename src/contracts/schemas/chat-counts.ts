import { z } from 'zod';
export const ChatCountsSchema = z.strictObject({
  connected: z.boolean(),
  undecidedRecent: z.number().finite().nullable(),
  agreementOutOfDate: z.number().finite(),
});
