import { z } from 'zod';
export const ModelBlockedSchema = z.union([
  z.literal('no_model'),
  z.literal('model_config_missing'),
  z.literal('model_endpoint_blocked'),
  z.literal('model_unauthorised'),
  z.literal('model_configuration_invalid'),
]);
