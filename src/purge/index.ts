import type { Ctx, Host, Id } from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';
export function withdrawChat(ctx: Ctx, host: Host, accountId: Id, chatId: Id): void {
  void ctx;
  void host;
  void accountId;
  void chatId;
  throw new AppError('invalid', 'not built: withdrawChat');
}
