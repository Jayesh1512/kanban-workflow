import type { Ctx, Id } from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';
export function forgetMessages(ctx: Ctx, messageIds: Id[]): { removedCardIds: Id[]; clearedCardIds: Id[] } {
  void ctx;
  void messageIds;
  throw new AppError('invalid', 'not built: forgetMessages');
}
