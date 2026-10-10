import type { ChatListEntry, HistoryPage, Id } from '../../contracts/index.ts';
import { AppError, HistoryPageSchema } from '../../contracts/index.ts';
import { clearSync, finishGaps, openGap } from './gaps.ts';
import type { Runtime, State } from './state.ts';
import type { PendingReply } from './store-once.ts';
import { resolveReplies, storeOnce } from './store-once.ts';

interface SyncRow {
  chat_id: Id;
  chat_key: string;
  kind: ChatListEntry['chat']['kind'];
  title: string;
  native_chat_id: string;
  live_cursor: string | null;
  sync_state: 'idle' | 'syncing' | 'failed';
  sync_after: string | null;
  sync_since: string | null;
  sync_limit: number | null;
  sync_resume: string | null;
  sync_newest: string | null;
  sync_failed_since: string | null;
}
interface Job {
  accountId: Id;
  chatId: Id;
  controller: AbortController;
  task: Promise<void>;
  pending: PendingReply[];
  fromTime: string;
}
const day = 86400000;
export function createScheduler(s: State) {
  const jobs = new Map<string, Job>();
  const tasks = new Set<Promise<void>>();
  const errors: unknown[] = [];
  const key = (a: Id, c: Id) => `${a}:${c}`;
  function row(accountId: Id, chatId: Id): SyncRow | undefined {
    return s.db.get<SyncRow>(
      "SELECT ac.*,ch.chat_key,ch.kind,ch.title FROM account_chat ac JOIN chat ch ON ch.id=ac.chat_id JOIN chat_selection cs ON cs.account_id=ac.account_id AND cs.chat_key=ch.chat_key WHERE ac.account_id=? AND ac.chat_id=? AND cs.decision='included' AND ch.withdrawn_at IS NULL",
      accountId,
      chatId,
    );
  }
  function valid(job: Job): boolean {
    // Check volatile cancellation BEFORE any DB access; late results after DB close are inert.
    return (
      !s.stopped &&
      !job.controller.signal.aborted &&
      s.active(job.accountId) &&
      Boolean(s.live.get(job.accountId)?.accepting) &&
      row(job.accountId, job.chatId)?.sync_state !== 'idle' &&
      row(job.accountId, job.chatId) !== undefined
    );
  }
  function track(p: Promise<void>): Promise<void> {
    const handled = p
      .catch((error: unknown) => {
        errors.push(error);
        s.oplog('error', 'host.work_failed', { code: 'host_state_failed' });
      })
      .finally(() => tasks.delete(handled));
    tasks.add(handled);
    return handled;
  }
  async function cancellable<T>(p: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
    if (signal.aborted) return undefined;
    let cancel: () => void = () => {};
    const cancelled = new Promise<undefined>((resolve) => {
      cancel = () => resolve(undefined);
      signal.addEventListener('abort', cancel, { once: true });
    });
    try {
      return await Promise.race([p, cancelled]);
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }
  function listing(a: Id, r: SyncRow): ChatListEntry {
    return (
      s.cached.get(a)?.find((e) => e.chat.key === r.chat_key) ?? {
        chat: { key: r.chat_key, kind: r.kind, title: r.title, nativeId: r.native_chat_id },
        latestAt: null,
        latestCursor: null,
      }
    );
  }
  function abandon(job: Job, entry: ChatListEntry): void {
    s.db.tx(() => {
      if (!valid(job)) return;
      openGap(s, job.accountId, job.chatId, job.fromTime);
      const r = row(job.accountId, job.chatId);
      if (!r) return;
      // A concurrently observed live cursor is never replaced by older metadata.
      s.db.run(
        `UPDATE account_chat SET ${clearSync},live_cursor=? WHERE account_id=? AND chat_id=?`,
        r.live_cursor === r.sync_after ? entry.latestCursor : r.live_cursor,
        job.accountId,
        job.chatId,
      );
      finishGaps(s, job.accountId, job.chatId, true);
    });
  }
  function commitPage(job: Job, page: HistoryPage): void {
    const pending = s.db.tx(() => {
      if (!valid(job)) return job.pending;
      const a = s.account(job.accountId);
      const next = [...job.pending];
      for (const message of page.messages) {
        const reply = storeOnce(s.system, a, job.chatId, message, 'history');
        if (reply) next.push(reply);
      }
      s.db.run(
        'UPDATE account_chat SET sync_resume=?,sync_newest=coalesce(sync_newest,?) WHERE account_id=? AND chat_id=?',
        page.resume,
        page.messages[0]?.cursor ?? null,
        job.accountId,
        job.chatId,
      );
      return resolveReplies(s.system, job.accountId, job.chatId, next);
    });
    job.pending = pending; // Only install memory corresponding to a successfully committed page.
  }
  async function fetch(job: Job, rt: Runtime): Promise<boolean> {
    if (!valid(job)) return false;
    const r = row(job.accountId, job.chatId);
    if (!r) return false;
    const entry = listing(job.accountId, r);
    const a = s.account(job.accountId);
    if (!s.factory(a.channel).capabilities.history) {
      abandon(job, entry);
      return true;
    }
    if (r.sync_failed_since !== null && s.now().getTime() - new Date(r.sync_failed_since).getTime() >= day) {
      abandon(job, entry);
      return true;
    }
    let complete = false;
    const iterator = rt.connector
      .fetchHistory({
        chat: { ...entry.chat, nativeId: r.native_chat_id },
        after: r.sync_after,
        since: r.sync_since,
        limit: r.sync_limit,
        resume: r.sync_resume,
      })
      [Symbol.asyncIterator]();
    try {
      // The I/O lock remains held until the outstanding next actually ends, including cancellation.
      for (;;) {
        const next = await iterator.next();
        if (!valid(job)) return false;
        if (next.done) {
          complete = true;
          break;
        }
        const page = HistoryPageSchema.safeParse(next.value);
        if (!page.success) throw new AppError('invalid', 'Invalid connector history page');
        commitPage(job, page.data);
      }
      s.db.tx(() => {
        if (!valid(job)) return;
        const current = row(job.accountId, job.chatId);
        if (!current) return;
        // Empty non-service results use the snapshot listing cursor ONLY after complete success.
        const newest = current.sync_newest ?? entry.latestCursor;
        s.db.run(
          `UPDATE account_chat SET ${clearSync},live_cursor=? WHERE account_id=? AND chat_id=?`,
          current.live_cursor === current.sync_after ? newest : current.live_cursor,
          job.accountId,
          job.chatId,
        );
        finishGaps(s, job.accountId, job.chatId, false);
      });
      return true;
    } catch {
      if (!valid(job)) return false;
      s.db.tx(() => {
        if (!valid(job)) return;
        s.db.run(
          "UPDATE account_chat SET sync_state='failed',sync_failed_since=coalesce(sync_failed_since,?) WHERE account_id=? AND chat_id=?",
          s.now().toISOString(),
          job.accountId,
          job.chatId,
        );
        openGap(s, job.accountId, job.chatId, job.fromTime);
      });
      s.oplog('warn', 'host.history_failed', { accountId: job.accountId, chatId: job.chatId });
      return false;
    } finally {
      if (!complete && iterator.return) {
        // No await of an uncooperative return: cancellation is bounded, and late failures are handled.
        void iterator
          .return()
          .catch(() => s.oplog('warn', 'host.history_cleanup_failed', { accountId: job.accountId }));
      }
    }
  }
  function schedule(accountId: Id, chatId: Id): void {
    const k = key(accountId, chatId);
    const rt = s.live.get(accountId);
    if (s.stopped || !rt?.accepting || jobs.has(k)) return;
    const r = row(accountId, chatId);
    if (!r || r.sync_state === 'idle') return;
    const fromTime =
      s.db.get<{ at: string | null }>('SELECT max(sent_at) AS at FROM message WHERE chat_id=?', chatId)?.at ??
      r.sync_since ??
      s.now().toISOString();
    const job: Job = {
      accountId,
      chatId,
      controller: new AbortController(),
      task: Promise.resolve(),
      pending: [],
      fromTime,
    };
    jobs.set(k, job);
    job.task = track(
      Promise.resolve()
        .then(async () => {
          let delay = 60000;
          // Retained failed work retries after a wait, never silently resets its original request.
          let wait = r.sync_state === 'failed';
          while (valid(job)) {
            const current = row(accountId, chatId);
            if (
              current?.sync_failed_since !== null &&
              current?.sync_failed_since !== undefined &&
              s.now().getTime() - new Date(current.sync_failed_since).getTime() >= day
            ) {
              abandon(job, listing(accountId, current));
              break;
            }
            if (wait) {
              const remaining =
                current?.sync_failed_since == null
                  ? day
                  : Math.max(0, day - (s.now().getTime() - new Date(current.sync_failed_since).getTime()));
              await cancellable(s.sleep(Math.min(delay, remaining)), job.controller.signal);
              delay = Math.min(delay * 2, 3600000);
              if (!valid(job)) break;
            }
            const done = await cancellable(
              s.serial(rt, () => fetch(job, rt)),
              job.controller.signal,
            );
            if (done || !valid(job)) break;
            wait = true;
          }
        })
        .finally(() => {
          jobs.delete(k);
          // Callback may have joined a later-rolled-back outer purge transaction. Durable state wins.
          if (job.controller.signal.aborted && !s.stopped && rt.accepting && s.active(accountId))
            schedule(accountId, chatId);
        }),
    );
  }
  function cancel(accountId: Id, chatId?: Id): void {
    for (const job of jobs.values())
      if (job.accountId === accountId && (chatId === undefined || job.chatId === chatId)) job.controller.abort();
  }
  function restore(accountId: Id): void {
    for (const r of s.db.all<SyncRow>(
      'SELECT ac.*,ch.chat_key,ch.kind,ch.title FROM account_chat ac JOIN chat ch ON ch.id=ac.chat_id WHERE ac.account_id=? AND ac.sync_state<>? ORDER BY ch.id',
      accountId,
      'idle',
    )) {
      if (r.sync_newest !== null || r.sync_failed_since !== null)
        s.db.tx(() =>
          openGap(
            s,
            accountId,
            r.chat_id,
            r.sync_since ??
              s.db.get<{ at: string | null }>('SELECT min(sent_at) AS at FROM message WHERE chat_id=?', r.chat_id)
                ?.at ??
              s.now().toISOString(),
          ),
        );
      schedule(accountId, r.chat_id);
    }
  }
  function catchup(accountId: Id): void {
    restore(accountId);
    for (const entry of s.cached.get(accountId) ?? []) {
      const r = s.db.get<SyncRow>(
        'SELECT ac.* FROM account_chat ac JOIN chat ch ON ch.id=ac.chat_id WHERE ac.account_id=? AND ch.channel=? AND ch.chat_key=?',
        accountId,
        s.account(accountId).channel,
        entry.chat.key,
      );
      if (r?.sync_state !== 'idle' || r.live_cursor === entry.latestCursor) continue;
      s.db.tx(() =>
        s.db.run(
          "UPDATE account_chat SET sync_state='syncing',sync_after=live_cursor,sync_since=NULL,sync_limit=NULL,sync_resume=NULL,sync_newest=NULL,sync_failed_since=NULL WHERE account_id=? AND chat_id=? AND sync_state='idle'",
          accountId,
          r.chat_id,
        ),
      );
      schedule(accountId, r.chat_id);
    }
  }
  return {
    schedule,
    cancel,
    restore,
    catchup,
    track,
    async settle() {
      while (tasks.size) await Promise.all([...tasks]);
      if (errors.length) {
        errors.length = 0;
        throw new AppError('invalid', 'Host background work failed');
      }
    },
  };
}
export type Scheduler = ReturnType<typeof createScheduler>;
