import type { Ctx, Id } from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';
export function forgetMessages(
  ctx: Ctx,
  i: { messageIds: Id[]; chatId: Id },
): { removedContactIds: Id[]; resetContactIds: Id[]; removedCompanyIds: Id[] } {
  void ctx;
  void i;
  throw new AppError('invalid', 'not built: forgetMessages');
}
