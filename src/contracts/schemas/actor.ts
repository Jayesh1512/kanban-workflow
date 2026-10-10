import { z } from 'zod';
import { IdSchema } from './id.ts';
export const ActorSchema = z.union([
  z.strictObject({ kind: z.literal('agent') }),
  z.strictObject({ kind: z.literal('teammate'), id: IdSchema }),
  z.strictObject({ kind: z.literal('credential'), id: IdSchema }),
  z.strictObject({ kind: z.literal('system') }),
]);
