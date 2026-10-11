import { AppError } from '../../contracts/index.ts';
import type { State } from './state.ts';

export async function cleanup(s: State, run: () => Promise<void>, ms: number): Promise<void> {
  const deadline = s.now().getTime() + ms;
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
  for (let n = 0; n < 64 && !finished; n++) await Promise.resolve();
  if (finished) return result;
  await Promise.race([
    result,
    s.sleep(Math.max(0, deadline - s.now().getTime())).then(() => {
      if (!finished) throw new AppError('invalid', 'Account cleanup timed out');
    }),
  ]);
}
