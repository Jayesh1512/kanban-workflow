import { z } from 'zod';
export const ChatRefSchema = z.strictObject({
  key: z.string().min(1),
  nativeId: z.string().min(1),
  kind: z.union([z.literal('direct'), z.literal('group'), z.literal('broadcast')]),
  title: z.string(),
});
