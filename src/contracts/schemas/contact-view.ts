import { z } from 'zod';
import { CardSummarySchema } from './card-summary.ts';
import { ContactSummarySchema } from './contact-summary.ts';
import { IdSchema } from './id.ts';
import { IsoTimeSchema } from './iso-time.ts';
import { MessageViewSchema } from './message-view.ts';
export const ContactViewSchema = ContactSummarySchema.extend({
  identities: z.array(
    z.strictObject({ id: IdSchema, channel: z.string(), displayName: z.string(), handle: z.string().nullable() }),
  ),
  roleEvidence: z.array(MessageViewSchema),
  companyEvidence: z.array(z.strictObject({ companyId: IdSchema, messages: z.array(MessageViewSchema) })),
  chats: z.array(z.strictObject({ id: IdSchema, title: z.string(), lastMessageAt: IsoTimeSchema.nullable() })),
  lastConversationAt: IsoTimeSchema.nullable(),
  recentMessages: z.array(MessageViewSchema),
  cards: z.array(CardSummarySchema),
});
