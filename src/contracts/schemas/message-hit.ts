import { z } from 'zod';
import { IdSchema } from './id.ts';
import { MessageViewSchema } from './message-view.ts';
export const MessageHitSchema = z.strictObject({
  message: MessageViewSchema,
  companies: z.array(z.strictObject({ id: IdSchema, name: z.string().min(1) })),
  card: z.strictObject({ id: IdSchema, title: z.string() }).nullable(),
});
