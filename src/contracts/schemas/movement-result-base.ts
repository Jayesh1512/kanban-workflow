import { z } from 'zod';
export const MovementResultBaseSchema = z.strictObject({
  provider: z.literal('jev'),
  execution: z.union([z.literal('hosted'), z.literal('replay'), z.literal('disabled')]),
  configuredModel: z.string().nullable(),
  providerRequestId: z.string().nullable(),
});
