import { z } from 'zod';
export const MovementConfigSchema = z.strictObject({
  provider: z.union([z.literal('jev'), z.literal('replay'), z.null()]),
  endpoint: z.string().nullable(),
  model: z.string().nullable(),
  apiKey: z.string().nullable(),
  replayPath: z.string().nullable(),
  timeoutMs: z.number().int().min(1).max(30000),
  maxAttempts: z.union([z.literal(1), z.literal(2)]),
});
