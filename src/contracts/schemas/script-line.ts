import { z } from 'zod';
import { ScriptDecisionSchema } from './script-decision.ts';
export const ScriptLineSchema = z.union([
  z.strictObject({
    messageKey: z.string().min(1),
    version: z.number().int().positive().safe(),
    decision: ScriptDecisionSchema,
  }),
  z.strictObject({ messageKey: z.string().min(1), version: z.number().int().positive().safe(), raw: z.unknown() }),
]);
