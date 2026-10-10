import { z } from 'zod';
export const ModelConfigSchema = z.strictObject({
  provider: z.union([z.literal('scripted'), z.literal('openai'), z.null()]),
  name: z.string().min(1).nullable(),
  apiKey: z.string().nullable(),
  scriptPath: z.string().nullable(),
  timeoutMs: z.number().int().min(1).max(60000),
  maxOutputTokens: z.number().int().min(1).max(16384),
  maxAttempts: z.union([z.literal(1), z.literal(2)]),
});
