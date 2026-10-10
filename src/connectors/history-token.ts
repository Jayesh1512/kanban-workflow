import { z } from 'zod';
import type { HistoryRequest } from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';

const tokenSchema = z
  .object({
    v: z.literal(1),
    account: z.string(),
    query: z.string(),
    before: z.string(),
    returned: z.number().int().nonnegative(),
  })
  .strict();
function query(req: HistoryRequest): string {
  return JSON.stringify([req.chat.key, req.chat.nativeId, req.after, req.since, req.limit]);
}
export function historyToken(account: string, req: HistoryRequest, before: string, returned: number): string {
  return JSON.stringify({ v: 1, account, query: query(req), before, returned });
}
export function readHistoryToken(account: string, req: HistoryRequest): { before: string; returned: number } | null {
  if (req.resume === null) return null;
  try {
    const parsed = tokenSchema.parse(JSON.parse(req.resume));
    if (parsed.account !== account || parsed.query !== query(req)) throw new Error('mismatch');
    return parsed;
  } catch {
    throw new AppError('invalid', 'Invalid history resume token');
  }
}
