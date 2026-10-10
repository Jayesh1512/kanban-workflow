import { z } from 'zod';
import { ChatRefSchema } from './chat-ref.ts';
import { IsoTimeSchema } from './iso-time.ts';
import { MessageRecordSchema } from './message-record.ts';
export const ConnectorEventSchema = z.union([
  z.strictObject({ type: z.literal('message'), chat: ChatRefSchema, message: MessageRecordSchema }),
  z.strictObject({ type: z.literal('edit'), chat: ChatRefSchema, message: MessageRecordSchema }),
  z.strictObject({ type: z.literal('delete'), nativeIds: z.array(z.string()), deletedAt: IsoTimeSchema }),
  z.strictObject({
    type: z.literal('status'),
    state: z.union([z.literal('connected'), z.literal('disconnected'), z.literal('auth_lost')]),
  }),
]);
