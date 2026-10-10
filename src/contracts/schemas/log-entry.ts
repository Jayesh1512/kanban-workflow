import { z } from 'zod';
import { IdSchema } from './id.ts';
import { IsoTimeSchema } from './iso-time.ts';
import { SubjectKindSchema } from './subject-kind.ts';
export const LogEntrySchema = z.strictObject({
  id: IdSchema,
  at: IsoTimeSchema,
  actor: z.strictObject({
    kind: z.enum(['agent', 'teammate', 'credential', 'system']),
    id: IdSchema.nullable(),
    name: z.string().min(1),
  }),
  action: z.string(),
  subjectKind: SubjectKindSchema,
  subjectId: IdSchema.nullable(),
  before: z.unknown(),
  after: z.unknown(),
  reason: z.string(),
  messageIds: z.array(IdSchema),
  correctsId: IdSchema.nullable(),
  followsHumanOverride: z.boolean(),
  redacted: z.boolean(),
});
