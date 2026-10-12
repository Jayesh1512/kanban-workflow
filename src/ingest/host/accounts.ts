import type { Ctx, Id, LoginStep } from '../../contracts/index.ts';
import { AppError, ConnectorEventSchema, LoginStepSchema } from '../../contracts/index.ts';
import { bindSelfIdentity } from '../../graph/index.ts';
import { record } from '../../log/index.ts';
import { checkCleanupDeadline, cleanup } from './cleanup.ts';
import { clearSync } from './gaps.ts';
import { refreshListing } from './listing.ts';
import { clearPending, resolveReplies } from './replies.ts';
import type { Scheduler } from './scheduler.ts';
import type { Account, Runtime, State } from './state.ts';
import { storeOnce } from './store-once.ts';
import { assertAccountOrigins } from './sync-origin.ts';

export function createAccounts(s: State, scheduler: Scheduler) {
  let stopping: Promise<void> | null = null;
  async function refresh(a: Account, rt: Runtime, generation: number): Promise<void> {
    await refreshListing(s, a, rt, () => !s.stopped && rt.epoch === generation && rt.accepting);
    if (!s.stopped && rt.epoch === generation && rt.accepting && s.active(a.id)) {
      rt.lastCatchup = s.now().getTime();
      scheduler.catchup(a.id);
    }
  }
  function reconnect(a: Account, rt: Runtime): void {
    if (rt.catchup || s.stopped || !rt.accepting) return;
    const generation = rt.epoch;
    const cancelled = new AbortController();
    let cancel: () => void = () => {};
    const stopped = new Promise<void>((resolve) => {
      cancel = () => {
        cancelled.abort();
        resolve();
      };
    });
    rt.cancelCatchup = cancel;
    rt.catchup = scheduler.track(
      Promise.race([
        Promise.resolve().then(async () => {
          const wait = (rt.lastCatchup ?? -Infinity) + 300000 - s.now().getTime();
          if (wait > 0) await s.sleep(wait);
          if (cancelled.signal.aborted || s.stopped || rt.epoch !== generation || !rt.accepting || !s.active(a.id))
            return;
          await refresh(a, rt, generation);
        }),
        stopped,
      ]).finally(() => {
        rt.catchup = null;
        rt.cancelCatchup = null;
      }),
    );
  }
  async function startAccount(a: Account): Promise<void> {
    assertAccountOrigins(s.db, a.id);
    if (!s.active(a.id)) return;
    let rt = s.live.get(a.id);
    if (rt?.fault) {
      rt.saving = false;
      s.live.delete(a.id);
      rt = undefined;
    }
    try {
      rt ??= s.runtime(a);
    } catch {
      s.status(a.id, 'disconnected');
      throw new AppError('invalid', 'Account connection failed');
    }
    const runtime = rt;
    return s.lifecycle(runtime, async () => {
      if (s.stopped || !s.active(a.id)) return;
      if (runtime.accepting) return;
      const generation = ++runtime.epoch;
      runtime.saving = true;
      runtime.accepting = true;
      runtime.starting = true;
      runtime.fault = false;
      try {
        await runtime.connector.start({
          async emit(value) {
            if (s.stopped || runtime.epoch !== generation || !s.active(a.id)) return;
            const parsed = ConnectorEventSchema.safeParse(value);
            if (!parsed.success) throw new AppError('invalid', 'Invalid connector event');
            const e = parsed.data;
            if (e.type === 'status') {
              if (e.state === 'auth_lost') {
                runtime.fault = true;
                runtime.accepting = false;
                runtime.saving = false;
                scheduler.cancel(a.id);
                s.status(a.id, 'auth_lost');
              } else if (e.state === 'disconnected') {
                runtime.accepting = false;
                if (runtime.starting) runtime.fault = true;
                scheduler.cancel(a.id);
                s.status(a.id, 'disconnected');
              } else if (!runtime.fault) {
                const previously = runtime.accepting;
                runtime.accepting = true;
                s.status(a.id, 'connected');
                if (!runtime.starting && !previously) reconnect(a, runtime);
              }
              return;
            }
            if (!runtime.accepting || runtime.fault) return;
            if (e.type === 'delete') return; // Exact H2 storage boundary: decoded, no mutation at H1.
            const entries = s.cached.get(a.id) ?? [];
            const current = entries.find((entry) => entry.chat.key === e.chat.key);
            if (!current) entries.push({ chat: e.chat, latestAt: e.message.sentAt, latestCursor: e.message.cursor });
            else if (current.latestAt === null || e.message.sentAt >= current.latestAt) {
              current.latestAt = e.message.sentAt;
              current.latestCursor = e.message.cursor;
            }
            s.cached.set(a.id, entries);
            if (e.type === 'edit') return; // Stored edits/versions/FTS changes wait for admitted H2.
            const ch = s.db.get<{ id: Id }>(
              "SELECT ch.id FROM chat ch JOIN chat_selection cs ON cs.chat_key=ch.chat_key WHERE ch.channel=? AND cs.account_id=? AND ch.chat_key=? AND cs.decision='included' AND ch.withdrawn_at IS NULL",
              a.channel,
              a.id,
              e.chat.key,
            );
            if (!ch) return;
            s.db.tx(() => {
              storeOnce(s.system, a, ch.id, e.message, 'live');
              resolveReplies(s.system, ch.id);
            });
          },
        });
        if (s.stopped || runtime.epoch !== generation) return;
        if (runtime.fault || !runtime.accepting || !s.active(a.id))
          throw new AppError('unauthenticated', 'Account connection failed');
        s.status(a.id, 'connected');
        await refresh(a, runtime, generation);
      } catch (error) {
        const deadline = s.now().getTime() + 5000;
        if (s.stopped || runtime.epoch !== generation) return;
        runtime.accepting = false;
        runtime.fault = true;
        scheduler.cancel(a.id);
        s.status(a.id, error instanceof AppError && error.code === 'unauthenticated' ? 'auth_lost' : 'disconnected');
        try {
          await cleanup(s, () => runtime.connector.stop(), deadline);
        } catch {
          s.oplog('warn', 'host.cleanup_failed', { accountId: a.id });
        }
        runtime.saving = false;
        throw new AppError('invalid', 'Account connection failed');
      } finally {
        runtime.starting = false;
      }
    });
  }
  async function login(ctx: Ctx, a: Account, input: Record<string, string> | null): Promise<LoginStep> {
    let rt: Runtime;
    try {
      rt = s.runtime(a);
    } catch {
      s.status(a.id, 'disconnected');
      throw new AppError('invalid', 'Account login failed');
    }
    return s.lifecycle(rt, async () => {
      s.owner(ctx, a.id);
      const generation = rt.epoch;
      try {
        const parsed = LoginStepSchema.safeParse(await rt.connector.login(input));
        if (!parsed.success) throw new AppError('invalid', 'Invalid connector login step');
        s.owner(ctx, a.id);
        if (rt.epoch !== generation || !rt.saving || rt.fault || s.live.get(a.id) !== rt)
          throw new AppError('invalid', 'Account login cancelled');
        const step = parsed.data;
        if (step.kind === 'done') {
          const historical = s.db.get<{ user_key: string; channel: string; teammate_id: Id }>(
            'SELECT i.user_key,i.channel,i.teammate_id FROM channel_account a JOIN identity i ON i.id=a.self_identity_id WHERE a.id=?',
            a.id,
          );
          if (
            historical &&
            (historical.user_key !== step.self.userKey ||
              historical.channel !== a.channel ||
              historical.teammate_id !== a.teammate_id)
          ) {
            const deadline = s.now().getTime() + 50000;
            // The authenticated new access is rejected before any self/history overwrite.
            rt.accepting = false;
            scheduler.cancel(a.id);
            s.db.tx(() => {
              s.db.run("UPDATE channel_account SET session_sealed=NULL,state='disconnected' WHERE id=?", a.id);
              record(s.system, {
                action: 'account.connect',
                subjectKind: 'account',
                subjectId: a.id,
                after: { state: 'disconnected' },
              });
            });
            rt.saving = false;
            try {
              await cleanup(s, () => rt.connector.logout(), deadline);
            } catch {
              s.oplog('warn', 'host.logout_failed', { accountId: a.id });
            }
            rt.epoch++;
            rt.fault = true;
            if (s.live.get(a.id) === rt) s.live.delete(a.id);
            throw new AppError('invalid', 'Account login failed');
          }
          s.db.tx(() => {
            const current = s.owner(ctx, a.id);
            if (current.session_sealed === null) throw new AppError('invalid', 'Account session missing');
            const identityId = bindSelfIdentity(ctx, { channel: a.channel, ...step.self, teammateId: a.teammate_id });
            s.db.run("UPDATE channel_account SET self_identity_id=?,state='connected' WHERE id=?", identityId, a.id);
            record(ctx, { action: 'account.connect', subjectKind: 'account', subjectId: a.id, after: { identityId } });
          });
        }
        return step.kind === 'failed'
          ? { kind: 'failed', message: 'Account login failed', retryable: step.retryable }
          : step;
      } catch (error) {
        const deadline = s.now().getTime() + 5000;
        if (rt.epoch === generation && s.active(a.id)) {
          rt.fault = true;
          rt.accepting = false;
          scheduler.cancel(a.id);
          s.status(
            a.id,
            s.account(a.id).state === 'auth_lost' || (error instanceof AppError && error.code === 'unauthenticated')
              ? 'auth_lost'
              : 'disconnected',
          );
          try {
            await cleanup(s, () => rt.connector.stop(), deadline);
          } catch {
            s.oplog('warn', 'host.cleanup_failed', { accountId: a.id });
          }
          rt.saving = false;
        }
        throw new AppError('invalid', 'Account login failed');
      }
    });
  }
  async function disconnect(ctx: Ctx, accountId: Id) {
    const deadline = s.now().getTime() + 50000;
    if (ctx.db !== s.db || ctx.actor.kind !== 'system') s.owner(ctx, accountId, true);
    const a = s.account(accountId);
    let rt = s.live.get(a.id);
    let restoreFailed = false;
    if (!rt && a.session_sealed !== null) {
      try {
        rt = s.runtime(a);
      } catch {
        restoreFailed = true;
      }
    }
    // Destroy access synchronously before awaiting logout. A late save can never resurrect it.
    s.db.tx(() => {
      clearPending(s.system, a.id);
      s.db.run(`UPDATE account_chat SET ${clearSync} WHERE account_id=?`, a.id);
      s.db.run("UPDATE channel_account SET state='removed',session_sealed=NULL WHERE id=?", a.id);
      record(ctx, { action: 'account.disconnect', subjectKind: 'account', subjectId: a.id });
    });
    if (rt) {
      rt.epoch++;
      rt.accepting = false;
      rt.saving = false;
      rt.cancelCatchup?.();
    }
    scheduler.cancel(a.id);
    s.cached.delete(a.id);
    if (restoreFailed) throw new AppError('invalid', 'Account removed; remote logout restoration failed');
    if (rt) {
      try {
        await cleanup(s, () => rt.connector.logout(), deadline);
        checkCleanupDeadline(s, deadline);
      } catch {
        s.oplog('warn', 'host.logout_failed', { accountId: a.id });
        throw new AppError('invalid', 'Account removed; remote logout failed');
      } finally {
        if (s.live.get(a.id) === rt) s.live.delete(a.id);
      }
    }
  }
  return {
    login,
    async startAll() {
      // Validate the WHOLE restored set before changing status, connector state, or hold.
      for (const a of s.db.all<Account>('SELECT * FROM channel_account ORDER BY id')) assertAccountOrigins(s.db, a.id);
      s.stopped = false;
      const results = await Promise.allSettled(
        s.db
          .all<Account>(
            "SELECT a.* FROM channel_account a JOIN teammate t ON t.id=a.teammate_id WHERE a.state IN ('connected','disconnected') AND t.removed_at IS NULL ORDER BY a.id",
          )
          .map(startAccount),
      );
      if (results.some((r) => r.status === 'rejected')) throw new AppError('invalid', 'Account connection failed');
    },
    async stopAll() {
      const deadline = s.now().getTime() + 5000;
      if (s.stopped) return stopping ?? undefined;
      s.stopped = true;
      stopping = (async () => {
        const results = await Promise.allSettled(
          [...s.live].map(async ([id, rt]) => {
            // A removed owner cannot authorize the connector's final session save.
            // Use the existing system-only removal boundary, retaining bounded logout failures.
            if (s.db.get('SELECT id FROM teammate WHERE id=? AND removed_at IS NOT NULL', s.account(id).teammate_id))
              return disconnect(s.system, id);
            rt.epoch++;
            rt.accepting = false;
            rt.cancelCatchup?.();
            scheduler.cancel(id);
            try {
              await cleanup(s, () => rt.connector.stop(), deadline);
              checkCleanupDeadline(s, deadline);
            } catch (error) {
              // A timed-out/faulted old port must never regain save authority on restart.
              rt.fault = true;
              if (s.live.get(id) === rt) s.live.delete(id);
              throw error;
            } finally {
              rt.saving = false;
            }
          }),
        );
        if (results.some((r) => r.status === 'rejected')) throw new AppError('invalid', 'Account stop failed');
      })();
      return stopping;
      // Canceled history/retry tasks resolve without awaiting an uncooperative external iterator.
    },
    disconnect,
  };
}
