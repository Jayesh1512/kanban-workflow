import { z } from 'zod';
import { IsoTimeSchema } from './iso-time.ts';
import { ModelResponseFailureSchema } from './model-response-failure.ts';
import { MovementProviderStatusSchema } from './movement-provider-status.ts';
export const PipelineStatusSchema = z.strictObject({
  state: z.union([z.literal('stopped'), z.literal('running'), z.literal('paused'), z.literal('blocked')]),
  reason: z.union([
    z.literal('model_unavailable'),
    z.literal('no_model'),
    z.literal('model_config_missing'),
    z.literal('model_endpoint_blocked'),
    z.literal('model_unauthorised'),
    z.literal('model_configuration_invalid'),
    z.null(),
  ]),
  since: IsoTimeSchema.nullable(),
  pending: z.number().finite(),
  movement: MovementProviderStatusSchema,
  modelFailure: z.union([
    ModelResponseFailureSchema,
    z.literal('timeout'),
    z.literal('unavailable'),
    z.literal('cancelled'),
    z.null(),
  ]),
});
