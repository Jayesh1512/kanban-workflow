import { z } from 'zod';
import type { Id } from '../../contracts/index.ts';
import { IdSchema, IsoTimeSchema } from '../../contracts/index.ts';
import { record } from '../../log/index.ts';
import type { State } from './state.ts';
import { assertGaps, assertOrigin, type OriginRow, unavailable } from './sync-origin.ts';

export const clearSync =
  "sync_state='idle',sync_after=NULL,sync_since=NULL,sync_limit=NULL,sync_resume=NULL,sync_newest=NULL,sync_failed_since=NULL,sync_origin_state='none',sync_gap_from=NULL";
function origin(s: State, accountId: Id, chatId: Id): string {
  const r = s.db.get<OriginRow>('SELECT * FROM account_chat WHERE account_id=? AND chat_id=?', accountId, chatId);
  if (!r) return unavailable();
  assertOrigin(r);
  assertGaps(s.db, accountId, chatId);
  if (r.sync_origin_state !== 'captured' || r.sync_gap_from === null) return unavailable();
  return r.sync_gap_from;
}
/** Transactional queue/open audit ordinals identify THIS request, never infer its origin.
 * Only the persisted captured scalar authorizes an exact bound. Lifecycle-retained
 * gaps preceding its queue, including equal-bound gaps, belong to older requests.
 */
function associated(s: State, accountId: Id, chatId: Id, fromTime: string) {
  const queue = s.db.get<{ id: Id }>(
    "SELECT id FROM action_log WHERE action='chat.sync_queue' AND subject_kind='chat' AND subject_id=? AND json_extract(after,'$.accountId')=? ORDER BY id DESC LIMIT 1",
    chatId,
    accountId,
  );
  if (!queue) return unavailable();
  const opened = s.db.get<{ after: string }>(
    "SELECT after FROM action_log WHERE action='chat.gap_open' AND subject_kind='chat' AND subject_id=? AND json_extract(after,'$.accountId')=? AND id>? ORDER BY id DESC LIMIT 1",
    chatId,
    accountId,
    queue.id,
  );
  if (!opened) return undefined;
  const parsed = z
    .strictObject({ accountId: IdSchema, fromTime: IsoTimeSchema, toTime: IsoTimeSchema })
    .safeParse(JSON.parse(opened.after));
  if (!parsed.success) return unavailable();
  const fact = parsed.data;
  const gap = s.db.get<{
    id: Id;
    from_time: string;
    to_time: string;
    bound_provenance: string;
    closed_at: string | null;
    abandoned_at: string | null;
  }>('SELECT * FROM chat_gap WHERE account_id=? AND chat_id=? ORDER BY id DESC LIMIT 1', accountId, chatId);
  if (
    gap?.bound_provenance !== 'exact' ||
    gap.from_time !== fromTime ||
    fact.fromTime !== fromTime ||
    gap.to_time !== fact.toTime ||
    gap.closed_at !== null ||
    gap.abandoned_at !== null
  )
    return unavailable();
  return gap;
}
export function openGap(s: State, accountId: Id, chatId: Id): void {
  const fromTime = origin(s, accountId, chatId);
  if (associated(s, accountId, chatId, fromTime)) return;
  const at = s.now().toISOString();
  s.db.run(
    "INSERT INTO chat_gap(account_id,chat_id,from_time,to_time,opened_at,bound_provenance) VALUES (?,?,?,?,?,'exact')",
    accountId,
    chatId,
    fromTime,
    at,
    at,
  );
  record(s.system, {
    action: 'chat.gap_open',
    subjectKind: 'chat',
    subjectId: chatId,
    after: { accountId, fromTime, toTime: at },
  });
}
export function finishGaps(s: State, accountId: Id, chatId: Id, abandoned: boolean): void {
  const fromTime = origin(s, accountId, chatId);
  const gap = associated(s, accountId, chatId, fromTime);
  if (!gap) return;
  s.db.run(
    `UPDATE chat_gap SET ${abandoned ? 'abandoned_at' : 'closed_at'}=? WHERE id=? AND bound_provenance='exact'`,
    s.now().toISOString(),
    gap.id,
  );
  record(s.system, {
    action: abandoned ? 'chat.gap_abandon' : 'chat.gap_close',
    subjectKind: 'chat',
    subjectId: chatId,
    after: { accountId },
  });
}
