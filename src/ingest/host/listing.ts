import { z } from 'zod';
import type { AccountView, ChatCounts, ChatListing, Ctx, Id } from '../../contracts/index.ts';
import { AppError, ChatListEntrySchema } from '../../contracts/index.ts';
import type { Account, Runtime, State } from './state.ts';
import { assertAccountOrigins } from './sync-origin.ts';

export async function refreshListing(s: State, a: Account, rt: Runtime, valid: () => boolean): Promise<void> {
  await s.serial(rt, async () => {
    if (!valid()) return;
    const result = z.array(ChatListEntrySchema).safeParse(await rt.connector.listChats());
    if (!result.success) throw new AppError('invalid', 'Invalid connector chat listing');
    if (!valid()) return;
    // Live metadata can advance while the asynchronous list is in flight.
    const entries = result.data;
    for (const live of s.cached.get(a.id) ?? []) {
      const existing = entries.find((e) => e.chat.key === live.chat.key);
      if (!existing) entries.push(live);
      else if (live.latestAt !== null && (existing.latestAt === null || live.latestAt > existing.latestAt)) {
        existing.latestAt = live.latestAt;
        existing.latestCursor = live.latestCursor;
      }
    }
    s.cached.set(a.id, entries);
  });
}
export function showListing(s: State, a: Account): ChatListing[] {
  return (s.cached.get(a.id) ?? []).map((e) => {
    const selection = s.db.get<{ decision: ChatListing['decision'] }>(
      'SELECT decision FROM chat_selection WHERE account_id=? AND chat_key=?',
      a.id,
      e.chat.key,
    );
    const ch = s.db.get<{ id: Id; withdrawn_at: string | null; withdrawnBy: string | null }>(
      'SELECT ch.*,t.display_name AS withdrawnBy FROM chat ch LEFT JOIN teammate t ON t.id=ch.withdrawn_by WHERE ch.channel=? AND ch.chat_key=?',
      a.channel,
      e.chat.key,
    );
    const stale =
      ch &&
      s.db.get(
        'SELECT chat_id FROM account_chat WHERE account_id=? AND chat_id=? AND agreement_stale_since IS NOT NULL',
        a.id,
        ch.id,
      );
    return {
      key: e.chat.key,
      chatId: ch?.id ?? null,
      kind: e.chat.kind,
      title: e.chat.title,
      latestAt: e.latestAt,
      decision: ch?.withdrawn_at != null ? 'withdrawn' : (selection?.decision ?? 'undecided'),
      agreementOutOfDate: Boolean(stale),
      withdrawnBy: ch?.withdrawnBy ?? null,
      withdrawnAt: ch?.withdrawn_at ?? null,
    };
  });
}
export function listAccounts(s: State, ctx: Ctx): AccountView[] {
  const ownerId = s.human(ctx);
  const accounts = s.db.all<Account>('SELECT * FROM channel_account WHERE teammate_id=? ORDER BY id', ownerId);
  for (const a of accounts) assertAccountOrigins(s.db, a.id);
  return accounts.map((a) => ({
    id: a.id,
    teammateId: a.teammate_id,
    channel: a.channel,
    label: s.factory(a.channel).label,
    state: a.state,
    gaps: s.db
      .all<{ chatId: Id; chatTitle: string; fromTime: string; toTime: string; abandoned: number }>(
        'SELECT g.chat_id AS chatId,ch.title AS chatTitle,g.from_time AS fromTime,g.to_time AS toTime,g.abandoned_at IS NOT NULL AS abandoned FROM chat_gap g JOIN chat ch ON ch.id=g.chat_id WHERE g.account_id=? AND g.closed_at IS NULL ORDER BY g.id',
        a.id,
      )
      .map((g) => ({ ...g, abandoned: Boolean(g.abandoned) })),
  }));
}
export function counts(s: State, ctx: Ctx): ChatCounts {
  const ownerId = s.human(ctx);
  const accounts = s.db.all<Account>("SELECT * FROM channel_account WHERE teammate_id=? AND state<>'removed'", ownerId);
  const connected = accounts.some((a) => a.state === 'connected' && !s.stopped);
  const known = connected && accounts.every((a) => a.state === 'connected' && s.cached.has(a.id));
  const since = new Date(s.now().getTime() - 7 * 86400000).toISOString();
  return {
    connected,
    undecidedRecent: known
      ? accounts.reduce(
          (n, a) =>
            n +
            (s.cached.get(a.id) ?? []).filter(
              (e) =>
                e.latestAt !== null &&
                e.latestAt >= since &&
                !s.db.get('SELECT decision FROM chat_selection WHERE account_id=? AND chat_key=?', a.id, e.chat.key) &&
                !s.db.get(
                  'SELECT id FROM chat WHERE channel=? AND chat_key=? AND withdrawn_at IS NOT NULL',
                  a.channel,
                  e.chat.key,
                ),
            ).length,
          0,
        )
      : null,
    agreementOutOfDate:
      s.db.get<{ n: number }>(
        'SELECT count(*) AS n FROM account_chat ac JOIN channel_account a ON a.id=ac.account_id WHERE a.teammate_id=? AND a.state<>? AND ac.agreement_stale_since IS NOT NULL',
        ownerId,
        'removed',
      )?.n ?? 0,
  };
}
