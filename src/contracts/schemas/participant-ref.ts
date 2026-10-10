import { z } from 'zod';
export const ParticipantRefSchema = z.strictObject({
  userKey: z.string().min(1),
  displayName: z.string(),
  handle: z.string().nullable(),
});
