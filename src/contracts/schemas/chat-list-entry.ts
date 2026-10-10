import { z } from 'zod';
import { ChatRefSchema } from './chat-ref.ts';
import { IsoTimeSchema } from './iso-time.ts';
export const ChatListEntrySchema = z.strictObject({
  chat: ChatRefSchema,
  latestAt: IsoTimeSchema.nullable(),
  latestCursor: z.string().nullable(),
});
