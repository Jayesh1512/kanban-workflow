import type { ConnectorContext } from '../../contracts/index.ts';
import { AppError } from '../../contracts/index.ts';
import type { createApiLifecycle } from './api-lifecycle.ts';
import type { createSessionState } from './session-state.ts';
import { readSession } from './session-state.ts';

const timeout = () => new AppError('invalid', 'Connector logout timed out/cancelled');
const failed = () => new AppError('invalid', 'Connector logout failed');

/** Absolute clock, with already-ready microtasks allowed to finish before asking the injected clock to wait. */
export async function within<T>(
  ctx: ConnectorContext,
  deadline: number,
  work: Promise<T>,
  cancel?: Promise<never>,
  isCancelled?: () => boolean,
) {
  let finished = false;
  const check = () => {
    if (isCancelled?.() || ctx.now().getTime() >= deadline) throw timeout();
  };
  const tracked = work.then(
    (value) => {
      finished = true;
      check();
      return value;
    },
    (error: unknown) => {
      finished = true;
      check();
      throw error;
    },
  );
  const timer = (async () => {
    for (let n = 0; n < 32 && !finished; n++) {
      await Promise.resolve();
      check();
    }
    check();
    if (finished) return new Promise<never>(() => {});
    const remaining = deadline - ctx.now().getTime();
    await ctx.sleep(remaining);
    check();
    return new Promise<never>(() => {});
  })();
  try {
    const value = await Promise.race(cancel ? [tracked, timer, cancel] : [tracked, timer]);
    check();
    return value;
  } catch (error) {
    check();
    throw error;
  }
}

export function createTerminalLogout(
  ctx: ConnectorContext,
  sessions: ReturnType<typeof createSessionState>,
  lifecycle: ReturnType<typeof createApiLifecycle>,
  rpc: () => Promise<void>,
  barrier: () => void,
  cleared: () => void,
) {
  let operation: Promise<void> | null = null;
  let cancel: (() => void) | null = null;
  return {
    active: () => operation !== null,
    assertOpen() {
      if (operation) throw new AppError('invalid', 'Connector stopping');
    },
    stop() {
      cancel?.();
      return operation;
    },
    logout() {
      if (operation) return operation;
      const t0 = ctx.now().getTime();
      const snapshot = sessions.barrier();
      barrier();
      lifecycle.pause();
      let valid = true;
      let cancelled = false; // Explicit stop survives ordinary preparation/final work invalidation.
      let rejectCancel: (error: AppError) => void = () => {};
      const cancellation = new Promise<never>((_, reject) => {
        rejectCancel = reject;
      });
      const invalidate = () => {
        valid = false;
        void lifecycle.destroy().catch(() => {}); // Abort now, even when the effective promise never settles.
      };
      cancel = () => {
        cancelled = true;
        invalidate();
        rejectCancel(timeout());
      };
      const check = () => {
        if (!valid || ctx.now().getTime() >= t0 + 45000) throw timeout();
      };
      const prepare = async () => {
        check();
        const saved = snapshot.saved === null ? null : readSession(snapshot.saved);
        check();
        const prior = lifecycle.prior();
        if (prior) {
          try {
            await prior;
          } catch {
            /* The first persistence fault remains authoritative. */
          }
          check();
        }
        if (saved !== null && !lifecycle.currentAuth()) {
          await lifecycle.importSession(saved.sdkSession);
          check();
        }
        if (lifecycle.currentAuth()) {
          check();
          await rpc();
          check();
        }
      };
      operation = (async () => {
        try {
          let error: unknown = snapshot.error;
          try {
            await within(ctx, t0 + 45000, prepare(), cancellation, () => cancelled);
          } catch (cause) {
            invalidate();
            if (!error)
              error =
                cause instanceof AppError &&
                ['Invalid saved connector session', 'Connector logout timed out/cancelled'].includes(cause.message)
                  ? cause
                  : failed();
          }
          error = snapshot.error ?? error;
          valid = false;
          const cleanupEnd = Math.min(ctx.now().getTime() + 5000, t0 + 50000);
          const destruction = lifecycle.destroy();
          // Callback ordering is synchronous: this tail runs after any reentrant callback stack returns.
          try {
            await sessions.clear();
            cleared();
            if (cancelled || ctx.now().getTime() >= cleanupEnd) throw timeout();
          } catch (cause) {
            error ??= cancelled ? timeout() : cause;
          }
          try {
            await within(ctx, cleanupEnd, destruction, cancellation, () => cancelled);
            if (cancelled || ctx.now().getTime() >= cleanupEnd) throw timeout();
          } catch (cause) {
            error ??=
              cancelled ||
              ctx.now().getTime() >= cleanupEnd ||
              (cause instanceof AppError && cause.message === timeout().message)
                ? timeout()
                : failed();
          }
          error = snapshot.error ?? error;
          sessions.finish();
          lifecycle.finish();
          if (error) throw error;
        } finally {
          // The public operation is this async promise. Admission closes in its final
          // synchronous job, as return/throw settles it; no later finalizer owns state.
          operation = null;
          cancel = null;
        }
      })();
      return operation;
    },
  };
}
