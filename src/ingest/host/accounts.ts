import { z } from 'zod';
import type { Ctx, Host, Id, LoginStep } from '../../contracts/index.ts';
import { AppError, ConnectorEventSchema, LoginStepSchema } from '../../contracts/index.ts';
import { bindSelfIdentity } from '../../graph/index.ts';
import { record } from '../../log/index.ts';
import { counts, listAccounts, refreshListing, showListing } from './listing.ts';
import type { Scheduler } from './scheduler.ts';
import type { Account, Runtime, State } from './state.ts';
import { resolveReplies, storeOnce } from './store-once.ts';

async function cleanup(s: State, run: () => Promise<void>, ms: number): Promise<void> {
  const operation = run();
  // Let a synchronous/microtask-only cleanup finish before allocating a deadline wait.
  let finished = false;
  const result = operation.then(
    () => {
      finished = true;
    },
    (error: unknown) => {
      finished = true;
      throw error;
    },
  );
  await Promise.resolve();
  await Promise.resolve();
  if (finished) return result;
  await Promise.race([
    result,
    s.sleep(ms).then(() => {
      if (!finished) throw new AppError('invalid', 'Account cleanup timed out');
    }),
  ]);
}
export function createAccounts(s: State, scheduler: Scheduler) {
  const replies = new Map<Id, ReturnType<typeof storeOnce>[]>();
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
            const pending = s.db.tx(() => {
              const reply = storeOnce(s.system, a, ch.id, e.message, 'live');
              const prior = (replies.get(a.id) ?? []).filter((p) => p !== null);
              if (reply) prior.push(reply);
              return resolveReplies(s.system, a.id, ch.id, prior);
            });
            replies.set(a.id, pending);
          },
        });
        if (s.stopped || runtime.epoch !== generation) return;
        if (runtime.fault || !runtime.accepting || !s.active(a.id))
          throw new AppError('unauthenticated', 'Account connection failed');
        s.status(a.id, 'connected');
        await refresh(a, runtime, generation);
      } catch (error) {
        if (s.stopped || runtime.epoch !== generation) return;
        runtime.accepting = false;
        runtime.fault = true;
        scheduler.cancel(a.id);
        s.status(a.id, error instanceof AppError && error.code === 'unauthenticated' ? 'auth_lost' : 'disconnected');
        try {
          await cleanup(s, () => runtime.connector.stop(), 5000);
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
        if (step.kind === 'done')
          s.db.tx(() => {
            const current = s.owner(ctx, a.id);
            if (current.session_sealed === null) throw new AppError('invalid', 'Account session missing');
            const identityId = bindSelfIdentity(ctx, { channel: a.channel, ...step.self, teammateId: a.teammate_id });
            s.db.run("UPDATE channel_account SET self_identity_id=?,state='connected' WHERE id=?", identityId, a.id);
            record(ctx, { action: 'account.connect', subjectKind: 'account', subjectId: a.id, after: { identityId } });
          });
        return step.kind === 'failed'
          ? { kind: 'failed', message: 'Account login failed', retryable: step.retryable }
          : step;
      } catch (error) {
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
            await cleanup(s, () => rt.connector.stop(), 5000);
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
    replies.delete(a.id);
    if (restoreFailed) throw new AppError('invalid', 'Account removed; remote logout restoration failed');
    if (rt) {
      try {
        await cleanup(s, () => rt.connector.logout(), 50000);
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
              await cleanup(s, () => rt.connector.stop(), 5000);
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
export function accountMethods(
  s: State,
  accounts: ReturnType<typeof createAccounts>,
  scheduler: Scheduler,
): Pick<
  Host,
  'listChannels' | 'listAccounts' | 'beginLogin' | 'continueLogin' | 'disconnect' | 'listChats' | 'chatCounts'
> {
  return {
    listChannels() {
      return s.connectors.map((f) => ({
        channel: f.channel,
        label: f.label,
        loginNotice: f.loginNotice(s.config.connectors[f.channel] ?? {}),
      }));
    },
    listAccounts: (ctx) => listAccounts(s, ctx),
    async beginLogin(ctx, channel, i) {
      const teammateId = s.human(ctx);
      if (!z.strictObject({ acknowledgedNoticeVersion: z.number().int().positive().nullable() }).safeParse(i).success)
        throw new AppError('invalid', 'Invalid login input');
      const notice = s.factory(channel).loginNotice(s.config.connectors[channel] ?? {});
      if (notice && notice.version !== i.acknowledgedNoticeVersion)
        throw new AppError('invalid', 'Login notice acknowledgement required');
      const id = s.db.tx(() => {
        const previous = s.db.get<Account>(
          'SELECT * FROM channel_account WHERE teammate_id=? AND channel=?',
          teammateId,
          channel,
        );
        const id =
          previous?.id ??
          s.db.run(
            "INSERT INTO channel_account(teammate_id,channel,state,created_at) VALUES (?,?,'login',?)",
            teammateId,
            channel,
            s.now().toISOString(),
          ).lastInsertRowid;
        s.db.run("UPDATE channel_account SET state='login' WHERE id=?", id);
        record(ctx, {
          action: 'account.acknowledge',
          subjectKind: 'account',
          subjectId: id,
          after: { noticeVersion: notice?.version ?? null },
        });
        return id;
      });
      const rt = s.live.get(id);
      if (rt?.accepting || rt?.fault) {
        rt.accepting = false;
        rt.epoch++;
        scheduler.cancel(id);
        try {
          await cleanup(s, () => rt.connector.stop(), 5000);
        } finally {
          rt.saving = false;
          s.live.delete(id);
        }
      }
      return { accountId: id, step: await accounts.login(ctx, s.account(id), null) };
    },
    async continueLogin(ctx, accountId, input) {
      const a = s.owner(ctx, accountId);
      if (a.state !== 'login') throw new AppError('invalid', 'Begin account login first');
      if (!z.record(z.string(), z.string()).safeParse(input).success)
        throw new AppError('invalid', 'Invalid login input');
      const notice = s.factory(a.channel).loginNotice(s.config.connectors[a.channel] ?? {});
      if (
        notice &&
        !s.db.get(
          "SELECT id FROM action_log WHERE action='account.acknowledge' AND subject_id=? AND actor_kind='teammate' AND actor_id=? AND json_extract(after,'$.noticeVersion')=? ORDER BY id DESC LIMIT 1",
          a.id,
          a.teammate_id,
          notice.version,
        )
      )
        throw new AppError('invalid', 'Login notice acknowledgement required');
      return accounts.login(ctx, a, input);
    },
    disconnect: accounts.disconnect,
    async listChats(ctx, accountId) {
      const a = s.owner(ctx, accountId);
      if (!s.active(a.id) || a.state === 'login') throw new AppError('unauthenticated', 'Account not connected');
      const rt = s.runtime(a);
      const generation = rt.epoch;
      await refreshListing(s, a, rt, () => rt.epoch === generation && s.active(a.id));
      s.owner(ctx, accountId);
      return showListing(s, a);
    },
    chatCounts: (ctx) => counts(s, ctx),
  };
}
