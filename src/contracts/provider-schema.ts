import { z } from 'zod';
import { ModelDecisionSchema } from './schemas.ts';

/** The Responses projection carries structure only; the strict Zod parser enforces application limits. */
function project(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(project);
  if (value === null || typeof value !== 'object') return value;
  const projected: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'const') projected.enum = [entry];
    else if (
      ![
        '$schema',
        'minimum',
        'maximum',
        'minLength',
        'maxLength',
        'pattern',
        'format',
        'minItems',
        'maxItems',
      ].includes(key)
    )
      projected[key] = project(entry);
  }
  return projected;
}
export const modelDecisionJsonSchema = project(z.toJSONSchema(ModelDecisionSchema, { target: 'draft-7' })) as Record<
  string,
  unknown
>;
