import { z } from 'zod';
export const SetBySchema = z.union([z.literal('agent'), z.literal('human')]);
