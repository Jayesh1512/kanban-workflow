import { z } from 'zod';
import { CardSummarySchema } from './card-summary.ts';
import { ContactSummarySchema } from './contact-summary.ts';
import { IdSchema } from './id.ts';
import { IsoTimeSchema } from './iso-time.ts';
import { KnownCompanyPanelSchema } from './known-company-panel.ts';
import { MessageViewSchema } from './message-view.ts';
export const CompanyViewSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1),
  aliases: z.array(z.string()),
  contacts: z.array(ContactSummarySchema),
  chats: z.array(
    z.strictObject({
      id: IdSchema,
      title: z.string(),
      teammates: z.array(z.strictObject({ id: IdSchema, name: z.string().min(1) })),
      lastMessageAt: IsoTimeSchema.nullable(),
    }),
  ),
  lastConversationAt: IsoTimeSchema.nullable(),
  recentMessages: z.array(MessageViewSchema),
  cards: z.array(CardSummarySchema),
  referencesOut: z.array(KnownCompanyPanelSchema),
  referencedBy: z.array(
    z.strictObject({
      referenceId: IdSchema,
      company: z.strictObject({ id: IdSchema, name: z.string().min(1) }).nullable(),
      message: MessageViewSchema,
    }),
  ),
});
