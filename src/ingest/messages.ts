import type { Ctx, Id, IsoTime, MessageHit, MessageView } from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';
export function getMessages(
  ctx: Ctx,
  q: { ids?: Id[]; chatId?: Id; cardId?: Id; contactId?: Id; companyId?: Id; limit?: number; before?: IsoTime },
): MessageView[] {
  void ctx;
  void q;
  throw new AppError('invalid', 'not built: getMessages');
}

export function searchMessages(
  ctx: Ctx,
  q: { text: string; companyId?: Id; contactId?: Id; limit?: number },
): MessageHit[] {
  void ctx;
  void q;
  throw new AppError('invalid', 'not built: searchMessages');
}

export function deleteMessages(ctx: Ctx, messageIds: Id[]): void {
  void ctx;
  void messageIds;
  throw new AppError('invalid', 'not built: deleteMessages');
}
