import type { Ctx, Id, ReviewChange, ReviewItemView } from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';
export function listReview(ctx: Ctx, q?: { limit?: number }): ReviewItemView[] {
  void ctx;
  void q;
  throw new AppError('invalid', 'not built: listReview');
}

export function getReview(ctx: Ctx, id: Id): ReviewItemView {
  void ctx;
  void id;
  throw new AppError('invalid', 'not built: getReview');
}

export function acceptReview(ctx: Ctx, id: Id): void {
  void ctx;
  void id;
  throw new AppError('invalid', 'not built: acceptReview');
}

export function changeReview(ctx: Ctx, id: Id, change: ReviewChange): void {
  void ctx;
  void id;
  void change;
  throw new AppError('invalid', 'not built: changeReview');
}

export function dismissReview(ctx: Ctx, id: Id): void {
  void ctx;
  void id;
  throw new AppError('invalid', 'not built: dismissReview');
}

export function recheckPendingMentions(ctx: Ctx): number {
  void ctx;
  throw new AppError('invalid', 'not built: recheckPendingMentions');
}
