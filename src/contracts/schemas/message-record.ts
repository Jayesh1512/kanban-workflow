import { z } from 'zod';
import { IsoTimeSchema } from './iso-time.ts';
import { ParticipantRefSchema } from './participant-ref.ts';
export const MessageRecordSchema = z.strictObject({
  key: z.string().min(1),
  nativeId: z.string().min(1),
  cursor: z.string().min(1),
  sender: ParticipantRefSchema,
  sentAt: IsoTimeSchema,
  text: z.string(),
  media: z.union([
    z.literal('photo'),
    z.literal('video'),
    z.literal('voice'),
    z.literal('audio'),
    z.literal('document'),
    z.literal('sticker'),
    z.literal('location'),
    z.literal('contact'),
    z.literal('poll'),
    z.literal('other'),
    z.null(),
  ]),
  replyToNativeId: z.string().nullable(),
  editedAt: IsoTimeSchema.nullable(),
});
