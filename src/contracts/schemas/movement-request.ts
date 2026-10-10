import { z } from 'zod';
import { IdSchema } from './id.ts';
import { IsoTimeSchema } from './iso-time.ts';
import { MovementEvidenceSchema } from './movement-evidence.ts';
import { MovementEvidenceOptionSchema } from './movement-evidence-option.ts';
import { MovementLaneSchema } from './movement-lane.ts';
import { MovementOptionSchema } from './movement-option.ts';
import { MovementSubjectSchema } from './movement-subject.ts';
export const MovementRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  requestId: z.string().min(1),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  message: z.strictObject({
    id: IdSchema,
    key: z.string().min(1),
    version: z.number().int().positive().safe(),
    chatId: IdSchema,
  }),
  subject: MovementSubjectSchema,
  current: z.strictObject({
    laneId: IdSchema,
    stageId: IdSchema,
    laneVersion: z.number().int().positive().safe(),
    title: z.string(),
    summary: z.string(),
    stageHumanSetAt: IsoTimeSchema.nullable(),
  }),
  lanes: z.array(MovementLaneSchema),
  options: z.array(MovementOptionSchema),
  evidence: z.array(MovementEvidenceSchema),
  evidenceOptions: z.array(MovementEvidenceOptionSchema),
});
