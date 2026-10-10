import { z } from 'zod';
export const ReviewKindSchema = z.union([
  z.literal('new_card'),
  z.literal('attach'),
  z.literal('move'),
  z.literal('is_work'),
  z.literal('contact_company'),
  z.literal('contact_role'),
  z.literal('name_company'),
  z.literal('model_failed'),
]);
