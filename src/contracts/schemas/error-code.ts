import { z } from 'zod';
export const ErrorCodeSchema = z.union([
  z.literal('unauthenticated'),
  z.literal('forbidden'),
  z.literal('not_found'),
  z.literal('invalid'),
  z.literal('conflict'),
]);
