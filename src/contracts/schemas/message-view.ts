import { z } from 'zod';
import { IdSchema } from './id.ts';
import { IsoTimeSchema } from './iso-time.ts';
export const MessageViewSchema = z.strictObject({
  id: IdSchema,
  chatId: IdSchema,
  chatTitle: z.string(),
  channel: z.string(),
  sender: z.strictObject({
    identityId: IdSchema,
    name: z.string().min(1),
    contactId: IdSchema.nullable(),
    teammateId: IdSchema.nullable(),
  }),
  direction: z.union([z.literal('in'), z.literal('out')]),
  sentAt: IsoTimeSchema,
  text: z.string().nullable(),
  media: z.string().nullable(),
  replyToId: IdSchema.nullable(),
  edited: z.boolean(),
  deleted: z.boolean(),
  fromHistory: z.boolean(),
  cardId: IdSchema.nullable(),
  teammateIds: z.array(IdSchema),
});
