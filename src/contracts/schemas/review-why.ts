import { z } from 'zod';
export const ReviewWhySchema = z.union([
  z.literal('low_confidence'),
  z.literal('cross_chat'),
  z.literal('cross_lane'),
  z.literal('human_override'),
  z.literal('similar_name'),
  z.literal('model_failed'),
]);
