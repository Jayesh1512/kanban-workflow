import { z } from 'zod';
import { CardSummarySchema } from './card-summary.ts';
import { ContactSummarySchema } from './contact-summary.ts';
import { IdSchema } from './id.ts';
import { IsoTimeSchema } from './iso-time.ts';
import { MessageViewSchema } from './message-view.ts';
export const KnownCompanyPanelSchema = z.strictObject({
  referenceId: IdSchema,
  company: z.strictObject({ id: IdSchema, name: z.string().min(1) }),
  message: MessageViewSchema,
  contacts: z.array(ContactSummarySchema),
  lastConversationAt: IsoTimeSchema.nullable(),
  openCards: z.array(CardSummarySchema),
});
