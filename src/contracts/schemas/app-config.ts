import { z } from 'zod';
import { ModelConfigSchema } from './model-config.ts';
import { MovementConfigSchema } from './movement-config.ts';
export const AppConfigSchema = z.strictObject({
  dataDir: z.string().min(1),
  secretKey: z.instanceof(Uint8Array).refine((v) => v.length === 32),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  origin: z.url(),
  connectors: z.record(z.string(), z.record(z.string(), z.string())),
  model: ModelConfigSchema,
  movement: MovementConfigSchema,
});
