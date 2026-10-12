import { AppError } from '../../contracts/index.ts';
import type { State } from './state.ts';

export function checkCleanupDeadline(s: State, deadline: number): void {
  if (s.now().getTime() >= deadline) throw new AppError('invalid', 'Account cleanup timed out');
}

/** A caller-owned absolute deadline includes its local preparation. Outcomes are
 * observed even after timeout; neither a ready rejection nor a timer loser can
 * become an unhandled rejection. The microtask grace consumes time, not budget.
 */
export async function cleanup(s: State, run: () => Promise<void>, deadline: number): Promise<void> {
  checkCleanupDeadline(s, deadline);
  let settled: { ok: true } | { ok: false; error: unknown } | undefined;
  let operation: Promise<void>;
  try {
    operation = run();
  } catch (error) {
    checkCleanupDeadline(s, deadline);
    throw error;
  }
  const result = operation.then(
    () => {
      settled = { ok: true };
    },
    (error: unknown) => {
      settled = { ok: false, error };
    },
  );
  // Retain timely synchronous/microtask cleanup without advancing an instant test clock.
  for (let n = 0; n < 64 && !settled; n++) {
    await Promise.resolve();
    checkCleanupDeadline(s, deadline);
  }
  if (!settled) {
    await Promise.race([
      result,
      s.sleep(Math.max(0, deadline - s.now().getTime())).then(() => {
        checkCleanupDeadline(s, deadline);
        if (!settled) throw new AppError('invalid', 'Account cleanup timed out');
      }),
    ]);
  }
  // Settlement and consumption are distinct async boundaries, including race winners.
  checkCleanupDeadline(s, deadline);
  if (settled && !settled.ok) throw settled.error;
}
