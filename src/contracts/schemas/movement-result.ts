import { z } from 'zod';
import { MovementChoiceSchema } from './movement-choice.ts';
import { MovementFailureSchema } from './movement-failure.ts';
import { MovementResultBaseSchema } from './movement-result-base.ts';
export const MovementResultSchema = z.union([
  MovementResultBaseSchema.extend({
    schemaVersion: z.literal(1),
    requestId: z.string().min(1),
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.literal('answered'),
    resolvedModel: z.string().nullable(),
    movement: MovementChoiceSchema,
    support: MovementChoiceSchema.nullable(),
    supportTarget: z.string().nullable(),
    supportQuestionId: z.string().nullable(),
    usage: MovementResultBaseSchema.extend({
      inputTokens: z.number().int().nonnegative().safe(),
      outputTokens: z.number().int().nonnegative().safe(),
    }).nullable(),
  }),
  MovementResultBaseSchema.extend({
    schemaVersion: z.literal(1),
    requestId: z.string().min(1),
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.literal('failed'),
    code: MovementFailureSchema,
  }),
  MovementResultBaseSchema.extend({
    schemaVersion: z.literal(1),
    requestId: z.string().min(1),
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.literal('not_requested'),
    code: z.literal('no_destination'),
  }),
]);
