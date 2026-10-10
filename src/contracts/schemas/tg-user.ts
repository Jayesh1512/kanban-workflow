import { z } from 'zod';
export const TgUserSchema = z.strictObject({
  id: z.number().finite(),
  displayName: z.string(),
  username: z.string().nullable(),
});
