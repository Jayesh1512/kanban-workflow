import { z } from 'zod';
export const ConfidenceSchema = z.number().finite().min(0).max(1);
