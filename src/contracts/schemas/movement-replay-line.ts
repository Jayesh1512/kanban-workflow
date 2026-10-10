import { z } from 'zod';
import { ConfidenceSchema } from './confidence.ts';
import { MovementFailureSchema } from './movement-failure.ts';
export const MovementReplayLineSchema = z.union([
  z.strictObject({
    messageKey: z.string().min(1),
    version: z.number().int().positive().safe(),
    subjectKey: z.string().min(1),
    answer: z.strictObject({
      destination: z.union([
        z.literal('stay'),
        z.literal('review'),
        z.strictObject({ lane: z.string(), stage: z.string() }),
      ]),
      evidenceMessageKeys: z.array(z.string()),
      confidence: ConfidenceSchema,
      supportConfidence: ConfidenceSchema,
    }),
  }),
  z.strictObject({
    messageKey: z.string().min(1),
    version: z.number().int().positive().safe(),
    subjectKey: z.string().min(1),
    raw: z.unknown(),
  }),
  z.strictObject({
    messageKey: z.string().min(1),
    version: z.number().int().positive().safe(),
    subjectKey: z.string().min(1),
    failure: MovementFailureSchema,
  }),
]);
