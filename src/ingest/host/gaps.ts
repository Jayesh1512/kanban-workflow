import type { Id } from '../../contracts/index.ts';
import { record } from '../../log/index.ts';
import type { State } from './state.ts';

export const clearSync =
  "sync_state='idle',sync_after=NULL,sync_since=NULL,sync_limit=NULL,sync_resume=NULL,sync_newest=NULL,sync_failed_since=NULL";
export function openGap(s: State, accountId: Id, chatId: Id, fromTime: string): void {
  if (
    s.db.get(
      'SELECT id FROM chat_gap WHERE account_id=? AND chat_id=? AND closed_at IS NULL AND abandoned_at IS NULL',
      accountId,
      chatId,
    )
  )
    return;
  const at = s.now().toISOString();
  s.db.run(
    'INSERT INTO chat_gap(account_id,chat_id,from_time,to_time,opened_at) VALUES (?,?,?,?,?)',
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
  const changes = abandoned
    ? s.db.run(
        'UPDATE chat_gap SET abandoned_at=? WHERE account_id=? AND chat_id=? AND closed_at IS NULL AND abandoned_at IS NULL',
        s.now().toISOString(),
        accountId,
        chatId,
      ).changes
    : s.db.run(
        'UPDATE chat_gap SET closed_at=? WHERE account_id=? AND chat_id=? AND closed_at IS NULL AND abandoned_at IS NULL',
        s.now().toISOString(),
        accountId,
        chatId,
      ).changes;
  if (changes)
    record(s.system, {
      action: abandoned ? 'chat.gap_abandon' : 'chat.gap_close',
      subjectKind: 'chat',
      subjectId: chatId,
      after: { accountId },
    });
}
