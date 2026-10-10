import { z } from 'zod';
import { MessageRecordSchema } from './message-record.ts';
export const HistoryPageSchema = z.strictObject({
  messages: z.array(MessageRecordSchema),
  resume: z.string().nullable(),
});
