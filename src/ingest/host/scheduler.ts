import type { ChatListEntry, HistoryPage, Id } from '../../contracts/index.ts';
import { AppError, HistoryPageSchema } from '../../contracts/index.ts';
import { record } from '../../log/index.ts';
import { clearSync, finishGaps, openGap } from './gaps.ts';
import { resolveReplies } from './replies.ts';
import type { Runtime, State } from './state.ts';
import { storeOnce } from './store-once.ts';
import { assertAccountOrigins, assertGaps, assertOrigin, type OriginRow } from './sync-origin.ts';

interface SyncRow extends OriginRow {
  chat_id: Id;
  chat_key: string;
  kind: ChatListEntry['chat']['kind'];
  title: string;
  native_chat_id: string;
  live_cursor: string | null;
}
interface Job {
  accountId: Id;
  chatId: Id;
  controller: AbortController;
  task: Promise<void>;
  epoch: number;
  queueId: Id;
  request: Pick<SyncRow, 'sync_after' | 'sync_since' | 'sync_limit'>;
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
  function queueId(accountId: Id, chatId: Id): Id {
    return (
      s.db.get<{ id: Id }>(
        "SELECT id FROM action_log WHERE action='chat.sync_queue' AND subject_kind='chat' AND subject_id=? AND json_extract(after,'$.accountId')=? ORDER BY id DESC LIMIT 1",
        chatId,
        accountId,
      )?.id ?? 0
    );
  }
  function valid(job: Job): boolean {
    // Volatile fences precede DB access: callbacks after removal/close are inert.
    if (
      s.stopped ||
      job.controller.signal.aborted ||
      jobs.get(key(job.accountId, job.chatId)) !== job ||
      !s.active(job.accountId)
    )
      return false;
    const rt = s.live.get(job.accountId);
    if (!rt?.accepting || rt.epoch !== job.epoch) return false;
    const r = row(job.accountId, job.chatId);
    if (!r || queueId(job.accountId, job.chatId) !== job.queueId) return false;
    assertOrigin(r);
    assertGaps(s.db, job.accountId, job.chatId);
    return (
      r.sync_state !== 'idle' &&
      r.sync_after === job.request.sync_after &&
      r.sync_since === job.request.sync_since &&
      r.sync_limit === job.request.sync_limit
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
  function audit(job: Job, action: string, timeKey: string, messageIds: Id[] = []): void {
    record(s.system, {
      action,
      subjectKind: 'chat',
      subjectId: job.chatId,
      after: { accountId: job.accountId, [timeKey]: s.now().toISOString() },
      messageIds,
    });
  }
  function capture(job: Job): SyncRow | undefined {
    return s.db.tx(() => {
      if (!valid(job)) return undefined;
      const r = row(job.accountId, job.chatId);
      if (!r) return undefined;
      if (r.sync_origin_state === 'queued') {
        const witness = s.db.get<{ id: Id; sent_at: string }>(
          'SELECT id,sent_at FROM message WHERE chat_id=? ORDER BY sent_at DESC,id DESC LIMIT 1',
          job.chatId,
        );
        const at = s.now().toISOString();
        const fromTime = witness?.sent_at ?? r.sync_since ?? at;
        s.db.run(
          "UPDATE account_chat SET sync_origin_state='captured',sync_gap_from=? WHERE account_id=? AND chat_id=?",
          fromTime,
          job.accountId,
          job.chatId,
        );
        record(s.system, {
          action: 'chat.sync_start',
          subjectKind: 'chat',
          subjectId: job.chatId,
          after: { accountId: job.accountId, fromTime, startedAt: at },
          messageIds: witness ? [witness.id] : [],
        });
      }
      return row(job.accountId, job.chatId);
    });
  }
  function abandon(job: Job, entry: ChatListEntry): void {
    s.db.tx(() => {
      if (!valid(job)) return;
      openGap(s, job.accountId, job.chatId);
      const r = row(job.accountId, job.chatId);
      if (!r) return;
      finishGaps(s, job.accountId, job.chatId, true);
      s.db.run(
        `UPDATE account_chat SET ${clearSync},live_cursor=? WHERE account_id=? AND chat_id=?`,
        r.live_cursor === r.sync_after ? entry.latestCursor : r.live_cursor,
        job.accountId,
        job.chatId,
      );
    });
  }
  function commitPage(job: Job, page: HistoryPage): void {
    s.db.tx(() => {
      if (!valid(job)) return;
      const a = s.account(job.accountId);
      const ids: Id[] = [];
      for (const message of page.messages) {
        const id = storeOnce(s.system, a, job.chatId, message, 'history');
        if (id !== null) ids.push(id);
      }
      ids.push(...resolveReplies(s.system, job.chatId));
      s.db.run(
        'UPDATE account_chat SET sync_resume=?,sync_newest=coalesce(sync_newest,?) WHERE account_id=? AND chat_id=?',
        page.resume,
        page.messages[0]?.cursor ?? null,
        job.accountId,
        job.chatId,
      );
      audit(job, 'chat.sync_page', 'committedAt', [...new Set(ids)]);
    });
  }
  async function fetch(job: Job, rt: Runtime): Promise<boolean> {
    // This runs INSIDE the acquired account I/O lane. No await separates capture from dispatch.
    const r = capture(job);
    if (!r) return false;
    const entry = listing(job.accountId, r);
    const a = s.account(job.accountId);
    if (
      !s.factory(a.channel).capabilities.history ||
      (r.sync_failed_since !== null && s.now().getTime() - new Date(r.sync_failed_since).getTime() >= day)
    ) {
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
      for (;;) {
        // Cancellation does not release the I/O lane until the actual next() ends.
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
        const newest = current.sync_newest ?? entry.latestCursor;
        finishGaps(s, job.accountId, job.chatId, false);
        s.db.run(
          `UPDATE account_chat SET ${clearSync},live_cursor=? WHERE account_id=? AND chat_id=?`,
          current.live_cursor === current.sync_after ? newest : current.live_cursor,
          job.accountId,
          job.chatId,
        );
        audit(job, 'chat.sync_complete', 'completedAt');
      });
      return true;
    } catch (error) {
      if (!valid(job)) return false;
      if (error instanceof AppError && error.message === 'Stored sync origin is unavailable') throw error;
      s.db.tx(() => {
        if (!valid(job)) return;
        s.db.run(
          "UPDATE account_chat SET sync_state='failed',sync_failed_since=coalesce(sync_failed_since,?) WHERE account_id=? AND chat_id=?",
          s.now().toISOString(),
          job.accountId,
          job.chatId,
        );
        openGap(s, job.accountId, job.chatId);
        audit(job, 'chat.sync_failure', 'failedAt');
      });
      s.oplog('warn', 'host.history_failed', { accountId: job.accountId, chatId: job.chatId });
      return false;
    } finally {
      if (!complete && iterator.return)
        void iterator
          .return()
          .catch(() => s.oplog('warn', 'host.history_cleanup_failed', { accountId: job.accountId }));
    }
  }
  function schedule(accountId: Id, chatId: Id, newRequest = false): void {
    assertAccountOrigins(s.db, accountId);
    const k = key(accountId, chatId);
    const rt = s.live.get(accountId);
    if (s.stopped || !rt?.accepting) return;
    const previous = jobs.get(k);
    if (
      !newRequest &&
      previous &&
      previous.queueId === queueId(accountId, chatId) &&
      !previous.controller.signal.aborted
    )
      return;
    previous?.controller.abort();
    const r = row(accountId, chatId);
    if (!r || r.sync_state === 'idle') return;
    const job: Job = {
      accountId,
      chatId,
      controller: new AbortController(),
      task: Promise.resolve(),
      epoch: rt.epoch,
      queueId: queueId(accountId, chatId),
      request: { sync_after: r.sync_after, sync_since: r.sync_since, sync_limit: r.sync_limit },
    };
    jobs.set(k, job);
    job.task = track(
      Promise.resolve()
        .then(async () => {
          let delay = 60000;
          let wait = r.sync_state === 'failed';
          while (valid(job)) {
            const current = row(accountId, chatId);
            if (
              current?.sync_failed_since != null &&
              s.now().getTime() - new Date(current.sync_failed_since).getTime() >= day
            ) {
              // Captured already; abandonment still owns the I/O dispatch boundary.
              await cancellable(
                s.serial(rt, () => fetch(job, rt)),
                job.controller.signal,
              );
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
          if (jobs.get(k) === job) jobs.delete(k);
          // A withdrawal callback can join an outer transaction which later rolls back.
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
    assertAccountOrigins(s.db, accountId);
    for (const r of s.db.all<SyncRow>(
      'SELECT ac.*,ch.chat_key,ch.kind,ch.title FROM account_chat ac JOIN chat ch ON ch.id=ac.chat_id WHERE ac.account_id=? AND ac.sync_state<>? ORDER BY ch.id',
      accountId,
      'idle',
    )) {
      if (r.sync_origin_state === 'captured') s.db.tx(() => openGap(s, accountId, r.chat_id));
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
      s.db.tx(() => {
        assertOrigin(r);
        assertGaps(s.db, accountId, r.chat_id);
        s.db.run(
          "UPDATE account_chat SET sync_state='syncing',sync_after=live_cursor,sync_since=NULL,sync_limit=NULL,sync_resume=NULL,sync_newest=NULL,sync_failed_since=NULL,sync_origin_state='queued',sync_gap_from=NULL WHERE account_id=? AND chat_id=? AND sync_state='idle'",
          accountId,
          r.chat_id,
        );
        record(s.system, {
          action: 'chat.sync_queue',
          subjectKind: 'chat',
          subjectId: r.chat_id,
          after: { accountId, queuedAt: s.now().toISOString() },
        });
      });
      schedule(accountId, r.chat_id, true);
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
        const error = errors.shift();
        errors.length = 0;
        if (error instanceof AppError && error.message === 'Stored sync origin is unavailable') throw error;
        throw new AppError('invalid', 'Host background work failed');
      }
    },
  };
}
export type Scheduler = ReturnType<typeof createScheduler>;
