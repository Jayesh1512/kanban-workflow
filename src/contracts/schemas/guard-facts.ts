import { z } from 'zod';
import { CompanyMatchSchema } from './company-match.ts';
import { IdSchema } from './id.ts';
import { IsoTimeSchema } from './iso-time.ts';
import { SetBySchema } from './set-by.ts';
export const GuardFactsSchema = z.strictObject({
  threshold: z.number().finite(),
  message: z.strictObject({
    id: IdSchema,
    chatId: IdSchema,
    sentAt: IsoTimeSchema,
    fromHistory: z.boolean(),
    cardLink: z.strictObject({ cardId: IdSchema.nullable(), setBy: SetBySchema }).nullable(),
  }),
  activeLaneIds: z.array(IdSchema),
  stages: z.array(z.strictObject({ id: IdSchema, laneId: IdSchema })),
  cards: z.array(
    z.strictObject({
      id: IdSchema,
      laneId: IdSchema,
      archived: z.boolean(),
      linkedToChat: z.boolean(),
      offeredToChat: z.boolean(),
      stageHumanSetAt: IsoTimeSchema.nullable(),
      textSetBy: SetBySchema,
      needsText: z.boolean(),
      companySetBy: SetBySchema.nullable(),
    }),
  ),
  proposals: z.array(
    z.strictObject({
      id: IdSchema,
      status: z.union([z.literal('open'), z.literal('accepted'), z.literal('changed'), z.literal('dismissed')]),
      resultCardId: IdSchema.nullable(),
    }),
  ),
  participants: z.array(z.strictObject({ contactId: IdSchema, roleSetBy: SetBySchema, hasHumanCompany: z.boolean() })),
  shownCompanyIds: z.array(IdSchema),
  matches: z.array(z.strictObject({ name: z.string().min(1), match: CompanyMatchSchema })),
  removedReferenceCompanyIds: z.array(IdSchema),
  validEvidenceIds: z.array(IdSchema),
  roleCategories: z.array(z.string()),
});
