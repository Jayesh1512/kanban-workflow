import { z } from 'zod';
export const ModelResponseFailureSchema = z.union([
  z.literal('refusal'),
  z.literal('incomplete'),
  z.literal('schema_invalid'),
  z.literal('unsupported_schema'),
  z.literal('context_limit'),
  z.literal('unauthorised'),
]);
