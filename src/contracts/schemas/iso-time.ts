import { z } from 'zod';
export const IsoTimeSchema = z.iso.datetime({ precision: 3 });
