import { z } from 'zod';
export const IdSchema = z.number().int().positive().safe();
