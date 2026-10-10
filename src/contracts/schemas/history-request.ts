import { z } from 'zod';
import { ChatRefSchema } from './chat-ref.ts';
import { IsoTimeSchema } from './iso-time.ts';
export const HistoryRequestSchema = z.strictObject({
  chat: ChatRefSchema,
  after: z.string().nullable(),
  since: IsoTimeSchema.nullable(),
  limit: z.number().finite().nullable(),
  resume: z.string().nullable(),
});
