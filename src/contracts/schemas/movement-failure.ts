import { z } from 'zod';
export const MovementFailureSchema = z.union([
  z.literal('missing_config'),
  z.literal('endpoint_blocked'),
  z.literal('unauthorised'),
  z.literal('unavailable'),
  z.literal('timeout'),
  z.literal('cancelled'),
  z.literal('invalid_response'),
  z.literal('stale'),
  z.literal('context_limit'),
]);
