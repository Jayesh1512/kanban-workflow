import { z } from 'zod';
export const TgPeerSchema = z.strictObject({
  type: z.union([z.literal('user'), z.literal('group'), z.literal('supergroup'), z.literal('channel')]),
  id: z.number().finite(),
});
