import { z } from 'zod';
import { ModelDecisionSchema } from './schemas.ts';

// JSON Schema metadata for Responses; application schemas remain the authority after parsing.
export const modelDecisionJsonSchema = z.toJSONSchema(ModelDecisionSchema, { target: 'draft-7' });
