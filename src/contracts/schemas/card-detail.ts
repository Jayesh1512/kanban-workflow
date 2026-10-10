import { z } from 'zod';
import { CardSummarySchema } from './card-summary.ts';
import { KnownCompanyPanelSchema } from './known-company-panel.ts';
import { LogEntrySchema } from './log-entry.ts';
import { MessageViewSchema } from './message-view.ts';
export const CardDetailSchema = CardSummarySchema.extend({
  summary: z.string(),
  messages: z.array(MessageViewSchema),
  history: z.array(LogEntrySchema),
  references: z.array(KnownCompanyPanelSchema),
});
