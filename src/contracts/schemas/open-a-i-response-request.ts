import { z } from 'zod';
export const OpenAIResponseRequestSchema = z.strictObject({
  model: z.string(),
  input: z.array(z.strictObject({ role: z.union([z.literal('system'), z.literal('user')]), content: z.string() })),
  text: z.strictObject({
    format: z.strictObject({
      type: z.literal('json_schema'),
      name: z.literal('kanban_decision'),
      strict: z.literal(true),
      schema: z.record(z.string(), z.unknown()),
    }),
  }),
  max_output_tokens: z.number().finite(),
  store: z.literal(false),
});
