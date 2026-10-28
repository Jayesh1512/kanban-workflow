import { z } from 'zod';
const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const status = z.enum(['available', 'unavailable']);
const cursor = z.string().min(1).max(4000);
export const listMeetingsSchema = z.strictObject({
  query: z.string().max(2000).optional(), customerId: uuid.optional(),
  customerState: z.enum(['unresolved', 'ambiguous']).optional(),
  from: timestamp.optional(), to: timestamp.optional(), recorder: z.string().max(500).optional(),
  meetingType: z.string().max(500).optional(), transcriptStatus: status.optional(),
  exportState: z.enum(['queued', 'dispatched', 'created', 'unknown', 'failed', 'canceled', 'none']).optional(),
  cursor: cursor.optional(), limit: z.number().int().min(1).max(200).optional(),
}).refine(v => !v.from || !v.to || Date.parse(v.from) < Date.parse(v.to), { message: 'from must precede to' });
export const getMeetingSchema = z.strictObject({ id: uuid });
export const transcriptSchema = z.strictObject({ id: uuid, revision: z.number().int().positive().optional(), cursor: cursor.optional(), limit: z.number().int().min(1).max(500).optional() });
export const setMeetingCustomersSchema = z.strictObject({ id: uuid, companyIds: z.array(uuid).max(100).refine(v => new Set(v).size === v.length, 'Duplicate company IDs'), expectedVersion: z.number().int().nonnegative(), reason: z.string().trim().min(1).max(4000) });
