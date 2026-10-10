import { z } from 'zod';
import { TgPeerSchema } from './tg-peer.ts';
export const TgDialogSchema = z.strictObject({
  peer: TgPeerSchema,
  title: z.string(),
  lastMessageId: z.number().finite().nullable(),
  lastMessageDate: z.number().finite().nullable(),
});
