import { z } from 'zod';
import { IdSchema } from './id.ts';
import { SubjectKindSchema } from './subject-kind.ts';
export const LogEntryInputSchema = z.strictObject({
  action: z.string(),
  subjectKind: SubjectKindSchema,
  subjectId: IdSchema.nullable(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  reason: z.string().optional(),
  messageIds: z.array(IdSchema).optional(),
  decisionId: IdSchema.nullable().optional(),
  correctsId: IdSchema.optional(),
  followsHumanOverride: z.boolean().optional(),
});
