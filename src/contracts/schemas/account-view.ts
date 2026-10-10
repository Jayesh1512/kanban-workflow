import { z } from 'zod';
import { IdSchema } from './id.ts';
import { IsoTimeSchema } from './iso-time.ts';
export const AccountViewSchema = z.strictObject({
  id: IdSchema,
  teammateId: IdSchema,
  channel: z.string(),
  label: z.string(),
  state: z.string(),
  gaps: z.array(
    z.strictObject({
      chatId: IdSchema,
      chatTitle: z.string(),
      fromTime: IsoTimeSchema,
      toTime: IsoTimeSchema,
      abandoned: z.boolean(),
    }),
  ),
});
