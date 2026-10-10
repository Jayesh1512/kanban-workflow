import { z } from 'zod';
import { ParticipantRefSchema } from './participant-ref.ts';
export const LoginStepSchema = z.union([
  z.strictObject({
    kind: z.literal('need_input'),
    fields: z.array(z.strictObject({ name: z.string().min(1), label: z.string(), secret: z.boolean() })),
    hint: z.string(),
  }),
  z.strictObject({ kind: z.literal('done'), self: ParticipantRefSchema }),
  z.strictObject({ kind: z.literal('failed'), message: z.string(), retryable: z.boolean() }),
]);
