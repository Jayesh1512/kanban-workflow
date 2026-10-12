import type { Db, Id } from '../../contracts/index.ts';
import { AppError, IsoTimeSchema } from '../../contracts/index.ts';

export interface OriginRow {
  sync_state: string;
  sync_origin_state: string;
  sync_gap_from: string | null;
  sync_after: string | null;
  sync_since: string | null;
  sync_limit: number | null;
  sync_resume: string | null;
  sync_newest: string | null;
  sync_failed_since: string | null;
}
export function unavailable(): never {
  throw new AppError('invalid', 'Stored sync origin is unavailable');
}
/** Recognition is PURE. Never upgrade, reset, retime, or hide historical state. */
export function assertOrigin(r: OriginRow): void {
  if (r.sync_since !== null && !IsoTimeSchema.safeParse(r.sync_since).success) unavailable();
  if (r.sync_failed_since !== null && !IsoTimeSchema.safeParse(r.sync_failed_since).success) unavailable();
  if (r.sync_limit !== null && (!Number.isSafeInteger(r.sync_limit) || r.sync_limit < 1)) unavailable();
  if (r.sync_state === 'idle') {
    if (
      r.sync_origin_state !== 'none' ||
      r.sync_gap_from !== null ||
      [r.sync_after, r.sync_since, r.sync_limit, r.sync_resume, r.sync_newest, r.sync_failed_since].some(
        (v) => v !== null,
      )
    )
      unavailable();
  } else if (r.sync_state === 'syncing' || r.sync_state === 'failed') {
    if (r.sync_origin_state === 'queued') {
      if (
        r.sync_gap_from !== null ||
        r.sync_state !== 'syncing' ||
        r.sync_resume !== null ||
        r.sync_newest !== null ||
        r.sync_failed_since !== null
      )
        unavailable();
    } else if (r.sync_origin_state === 'captured') {
      if (
        !IsoTimeSchema.safeParse(r.sync_gap_from).success ||
        (r.sync_state === 'failed' && r.sync_failed_since === null)
      )
        unavailable();
    } else unavailable();
  } else unavailable();
}
export function assertGaps(db: Db, accountId: Id, chatId?: Id): void {
  const gaps =
    chatId === undefined
      ? db.all<{ bound_provenance: string }>(
          'SELECT bound_provenance FROM chat_gap WHERE account_id=? AND closed_at IS NULL',
          accountId,
        )
      : db.all<{ bound_provenance: string }>(
          'SELECT bound_provenance FROM chat_gap WHERE account_id=? AND chat_id=? AND closed_at IS NULL',
          accountId,
          chatId,
        );
  if (gaps.some((g) => g.bound_provenance !== 'exact')) unavailable();
}
export function assertAccountOrigins(db: Db, accountId: Id): void {
  for (const r of db.all<OriginRow>('SELECT * FROM account_chat WHERE account_id=?', accountId)) assertOrigin(r);
  assertGaps(db, accountId);
}
