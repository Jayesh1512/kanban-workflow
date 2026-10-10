import { z } from 'zod';
import { ChatRefSchema } from './chat-ref.ts';
import { IsoTimeSchema } from './iso-time.ts';
import { MessageRecordSchema } from './message-record.ts';
import { ParticipantRefSchema } from './participant-ref.ts';
export const FixtureLineSchema = z.union([
  z.strictObject({ t: z.literal('config'), pageSize: z.number().int().positive().safe() }),
  z.strictObject({ t: z.literal('account'), account: z.string(), self: ParticipantRefSchema }),
  z.strictObject({ t: z.literal('chat'), account: z.string(), chat: ChatRefSchema }),
  z.strictObject({
    t: z.literal('message'),
    account: z.string(),
    delivery: z.union([z.literal('live'), z.literal('missed'), z.literal('history')]),
    chatKey: z.string(),
    message: MessageRecordSchema,
  }),
  z.strictObject({ t: z.literal('edit'), account: z.string(), chatKey: z.string(), message: MessageRecordSchema }),
  z.strictObject({
    t: z.literal('delete'),
    account: z.string(),
    nativeIds: z.array(z.string()),
    deletedAt: IsoTimeSchema,
  }),
  z.strictObject({
    t: z.literal('history_error'),
    account: z.string(),
    chatKey: z.string(),
    afterPages: z.number().int().nonnegative().safe(),
    times: z.number().finite().optional(),
  }),
  z.strictObject({ t: z.literal('mark'), name: z.string().min(1) }),
]);
