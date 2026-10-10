import { z } from 'zod';
import { CompanyRefSchema } from './company-ref.ts';
import { IdSchema } from './id.ts';
export const ActionSchema = z.union([
  z.strictObject({
    type: z.literal('card.create'),
    laneId: IdSchema,
    title: z.string().min(1).max(80),
    summary: z.string().max(400),
    chatId: IdSchema,
    messageId: IdSchema,
    companyId: IdSchema.nullable(),
    fromHistory: z.boolean(),
  }),
  z.strictObject({
    type: z.literal('message.attach'),
    messageId: IdSchema,
    cardId: IdSchema,
    title: z.string().min(1).max(80).nullable(),
    summary: z.string().max(400).nullable(),
    companyId: IdSchema.nullable(),
  }),
  z.strictObject({
    type: z.literal('card.move'),
    cardId: IdSchema,
    toStageId: IdSchema,
    criterion: z.string().min(1),
    evidenceMessageIds: z.array(IdSchema),
  }),
  z.strictObject({
    type: z.literal('contact.set_company'),
    contactId: IdSchema,
    company: CompanyRefSchema,
    evidenceMessageIds: z.array(IdSchema),
  }),
  z.strictObject({
    type: z.literal('contact.set_role'),
    contactId: IdSchema,
    category: z.string(),
    dealsAbout: z.string(),
    evidenceMessageIds: z.array(IdSchema),
  }),
  z.strictObject({ type: z.literal('reference.record'), toCompanyId: IdSchema, messageId: IdSchema }),
]);
