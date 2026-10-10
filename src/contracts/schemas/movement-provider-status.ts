import { z } from 'zod';
import { MovementFailureSchema } from './movement-failure.ts';
export const MovementProviderStatusSchema = z.strictObject({
  provider: z.literal('jev').nullable(),
  execution: z.union([z.literal('hosted'), z.literal('replay'), z.literal('disabled')]),
  state: z.union([z.literal('ready'), z.literal('blocked'), z.literal('degraded')]),
  reason: MovementFailureSchema.nullable(),
  endpointHost: z.string().nullable(),
  model: z.string().nullable(),
});
