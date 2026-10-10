import { z } from 'zod';
import { MessageRecordSchema } from './message-record.ts';
import { TgPeerSchema } from './tg-peer.ts';
import { TgUserSchema } from './tg-user.ts';
export const TgMessageSchema = z.strictObject({
  id: z.number().finite(),
  peer: TgPeerSchema,
  sender: TgUserSchema,
  date: z.number().finite(),
  text: z.string(),
  media: MessageRecordSchema.shape.media,
  mediaUniqueId: z.string().nullable(),
  replyToId: z.number().finite().nullable(),
  editDate: z.number().finite().nullable(),
  isService: z.boolean(),
});
