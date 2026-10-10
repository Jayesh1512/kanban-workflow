import type { CardDetail, CardSummary, Ctx, Id, LaneView, WriteOpts } from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';

export function updateLane(
  ctx: Ctx,
  laneId: Id,
  i: { name?: string; sop?: string; stages?: { id?: Id; name: string; criteria: string }[] },
): LaneView {
  void ctx;
  void laneId;
  void i;
  throw new AppError('invalid', 'not built: updateLane');
}

export function archiveLane(ctx: Ctx, laneId: Id): void {
  void ctx;
  void laneId;
  throw new AppError('invalid', 'not built: archiveLane');
}

export function listLanes(ctx: Ctx, o?: { includeArchived?: boolean }): LaneView[] {
  void ctx;
  void o;
  throw new AppError('invalid', 'not built: listLanes');
}

export function getCard(ctx: Ctx, cardId: Id): CardDetail {
  void ctx;
  void cardId;
  throw new AppError('invalid', 'not built: getCard');
}

export function searchCards(
  ctx: Ctx,
  q: {
    laneId?: Id;
    stageId?: Id;
    companyId?: Id;
    contactId?: Id;
    text?: string;
    includeArchived?: boolean;
    limit?: number;
    offset?: number;
  },
): { cards: CardSummary[]; total: number } {
  void ctx;
  void q;
  throw new AppError('invalid', 'not built: searchCards');
}

export function candidateCards(ctx: Ctx, chatId: Id): { cardId: Id; link: 'this_chat' | 'other_chat' }[] {
  void ctx;
  void chatId;
  throw new AppError('invalid', 'not built: candidateCards');
}

export function updateCard(
  ctx: Ctx,
  cardId: Id,
  i: { title?: string; summary?: string; companyId?: Id | null },
  o?: WriteOpts,
): void {
  void ctx;
  void cardId;
  void i;
  void o;
  throw new AppError('invalid', 'not built: updateCard');
}

export function dismissCardOffer(ctx: Ctx, cardId: Id, chatId: Id): void {
  void ctx;
  void cardId;
  void chatId;
  throw new AppError('invalid', 'not built: dismissCardOffer');
}

export function archiveCard(ctx: Ctx, cardId: Id): void {
  void ctx;
  void cardId;
  throw new AppError('invalid', 'not built: archiveCard');
}

export function unarchiveCard(ctx: Ctx, cardId: Id): void {
  void ctx;
  void cardId;
  throw new AppError('invalid', 'not built: unarchiveCard');
}
export type * from '../contracts/index.ts';
export { forgetMessages } from './forget.ts';

export { attachMessage, createCard, createLane, getBoard, moveCard } from './spine.ts';
