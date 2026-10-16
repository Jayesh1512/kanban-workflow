import type { Ctx, Id, Outcome, ReviewProposal, ReviewWhy } from '../contracts/index.ts';
import { AppError, ReviewProposalSchema } from '../contracts/index.ts';
import { record } from '../log/index.ts';

export function addReview(
  ctx: Ctx,
  outcome: Extract<Outcome, { do: 'review' }>,
  messageIds: Id[],
  decisionId: Id | null,
  reason: string,
): Id {
  const old = ctx.db.get<{ id: Id; proposal: string }>(
    "SELECT id,proposal FROM review_item WHERE kind=? AND group_key=? AND status='open'",
    outcome.kind,
    outcome.groupKey,
  );
  let proposal = outcome.proposal;
  if (old && proposal.kind === 'name_company') {
    const previous = ReviewProposalSchema.parse(JSON.parse(old.proposal));
    if (previous.kind !== 'name_company') throw new AppError('invalid', 'Invalid review group');
    proposal = {
      ...proposal,
      held: [...previous.held, ...proposal.held].filter(
        (use, index, list) => list.findIndex((u) => JSON.stringify(u) === JSON.stringify(use)) === index,
      ),
    };
  }
  const at = ctx.now().toISOString();
  const id =
    old?.id ??
    ctx.db.run(
      "INSERT INTO review_item(kind,group_key,chat_id,proposal,why,confidence,reason,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'open',?,?)",
      outcome.kind,
      outcome.groupKey,
      outcome.chatId,
      JSON.stringify(proposal),
      outcome.why,
      outcome.confidence,
      reason,
      at,
      at,
    ).lastInsertRowid;
  if (old)
    ctx.db.run(
      'UPDATE review_item SET proposal=?,why=?,confidence=?,reason=?,updated_at=? WHERE id=?',
      JSON.stringify(proposal),
      outcome.why,
      outcome.confidence,
      reason,
      at,
      id,
    );
  for (const messageId of new Set(messageIds))
    ctx.db.run(
      'INSERT INTO review_message(review_item_id,message_id,decision_id) VALUES (?,?,?) ON CONFLICT(review_item_id,message_id) DO UPDATE SET decision_id=excluded.decision_id',
      id,
      messageId,
      decisionId,
    );
  record(ctx, {
    action: old ? 'review.join' : 'review.create',
    subjectKind: 'review',
    subjectId: id,
    before: old ? { proposal: JSON.parse(old.proposal) as unknown } : undefined,
    after: { proposal, why: outcome.why, confidence: outcome.confidence },
    reason,
    messageIds,
    decisionId,
  });
  return id;
}
export function joinProposal(
  ctx: Ctx,
  id: Id,
  messageId: Id,
  decisionId: Id,
  summary: string | null,
  move: Extract<ReviewProposal, { kind: 'new_card' }>['move'],
  reason: string,
  why: ReviewWhy,
  confidence: number,
): void {
  const row = ctx.db.get<{ proposal: string; status: string }>(
    'SELECT proposal,status FROM review_item WHERE id=?',
    id,
  );
  if (row?.status !== 'open') throw new AppError('conflict', 'Review already settled');
  const old = ReviewProposalSchema.parse(JSON.parse(row.proposal));
  if (old.kind !== 'new_card') throw new AppError('invalid', 'Invalid proposal join');
  const proposal = { ...old, summary: summary ?? old.summary, move };
  ctx.db.run(
    'UPDATE review_item SET proposal=?,why=?,confidence=?,reason=?,updated_at=? WHERE id=?',
    JSON.stringify(proposal),
    why,
    confidence,
    reason,
    ctx.now().toISOString(),
    id,
  );
  ctx.db.run(
    'INSERT INTO review_message(review_item_id,message_id,decision_id) VALUES (?,?,?) ON CONFLICT(review_item_id,message_id) DO UPDATE SET decision_id=excluded.decision_id',
    id,
    messageId,
    decisionId,
  );
  record(ctx, {
    action: 'review.join',
    subjectKind: 'review',
    subjectId: id,
    before: { proposal: old },
    after: { proposal },
    reason,
    messageIds: [messageId],
    decisionId,
  });
}
