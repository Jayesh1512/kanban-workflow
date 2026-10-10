import { z } from 'zod';
import { IdSchema } from './id.ts';
export const MovementSubjectSchema = z.union([
  z.strictObject({ kind: z.literal('card'), cardId: IdSchema }),
  z.strictObject({ kind: z.literal('new_card'), openedByMessageKey: z.string() }),
  z.strictObject({ kind: z.literal('proposal'), proposalId: IdSchema, openedByMessageKey: z.string() }),
]);
