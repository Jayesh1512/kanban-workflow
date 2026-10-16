import { z } from 'zod';
import type {
  Ctx,
  DecideInput,
  Id,
  ModelDecision,
  ReviewProposal,
  WorkflowInferenceRequest,
} from '../contracts/index.ts';
import { AppError, IdSchema, ReviewProposalSchema } from '../contracts/index.ts';
import { digest } from './json.ts';
import { validateSettlement } from './movement/audit.ts';
import { joinProposal } from './review-groups.ts';
import { eligibleChat } from './selection.ts';

/** Resolve only an actually offered, same-chat workflow proposal and its actual result. */
export function workflowProposalContext(ctx: Ctx, input: DecideInput, d: ModelDecision) {
  if (d.disposition !== 'join' || d.proposalId === null) return null;
  const offered = input.proposals.find((p) => p.id === d.proposalId);
  if (!offered) return null;
  const row = ctx.db.get<{ id: Id; proposal: string; status: string; result_card_id: Id | null }>(
    "SELECT id,proposal,status,result_card_id FROM review_item WHERE id=? AND chat_id=? AND kind='new_card'",
    offered.id,
    input.chat.id,
  );
  if (!row || !['open', 'accepted', 'changed'].includes(row.status)) return null;
  const parsed = ReviewProposalSchema.safeParse(JSON.parse(row.proposal));
  if (
    !parsed.success ||
    parsed.data.kind !== 'new_card' ||
    parsed.data.laneId !== offered.laneId ||
    parsed.data.title !== offered.title ||
    parsed.data.summary !== offered.summary
  )
    return null;
  // Historical proposal data is immutable audit, not the location of a human's result.
  // Settled proposals resolve only their exact, currently offered same-chat linked card.
  const result =
    row.status === 'open' ? null : input.cards.find((c) => c.id === row.result_card_id && c.link === 'this_chat');
  if (row.status !== 'open' && !result) return null;
  const laneId = result?.laneId ?? parsed.data.laneId;
  if (
    !input.lanes.some((l) => l.id === laneId) ||
    !ctx.db.get(
      'SELECT w.id FROM workflow_config w JOIN lane l ON l.id=w.lane_id WHERE w.lane_id=? AND l.archived_at IS NULL',
      laneId,
    ) ||
    (result &&
      !ctx.db.get(
        'SELECT c.id FROM card c JOIN card_chat cc ON cc.card_id=c.id WHERE c.id=? AND c.lane_id=? AND c.stage_id=? AND c.archived_at IS NULL AND cc.chat_id=?',
        result.id,
        result.laneId,
        result.stageId,
        input.chat.id,
      ))
  )
    return null;
  return { ...row, proposal: parsed.data };
}
export function joinWorkflowProposal(
  ctx: Ctx,
  request: WorkflowInferenceRequest,
  summary: string | null,
  decisionId: Id,
  reason: string,
  confidence: number,
  stage?: { id: Id; messageId: Id; model: string },
): void {
  const offered = request.proposal;
  if (!offered) throw new AppError('conflict', 'Workflow proposal context is unavailable');
  const row = ctx.db.get<{ proposal: string; status: string }>(
    'SELECT proposal,status FROM review_item WHERE id=? AND chat_id=?',
    offered.id,
    request.chatId,
  );
  if (row?.status !== 'open' || digest(JSON.parse(row.proposal)) !== offered.hash)
    throw new AppError('conflict', 'Workflow proposal changed');
  // Clearing on every failed/unsupported response also removes earlier unauthorised moves.
  joinProposal(
    ctx,
    offered.id,
    request.messageId,
    decisionId,
    summary,
    stage
      ? {
          toStageId: stage.id,
          criterion: 'Jev retained evidence supports this workflow stage; no verified transaction claim',
        }
      : null,
    reason,
    stage ? 'low_confidence' : 'model_failed',
    confidence,
  );
  if (stage) {
    const p = ctx.db.get<{ proposal: string }>('SELECT proposal FROM review_item WHERE id=?', offered.id);
    const raw = ctx.db.get<{ raw: string }>('SELECT raw FROM decision WHERE id=?', decisionId);
    ctx.db.run(
      'UPDATE decision SET raw=? WHERE id=?',
      JSON.stringify({
        ...JSON.parse(raw?.raw ?? '{}'),
        __workflowStageReview: {
          reviewId: offered.id,
          proposalHash: digest(JSON.parse(p?.proposal ?? 'null')),
          stageId: stage.id,
          evidenceMessageId: stage.messageId,
          confidence,
          provider: 'jev',
          model: stage.model,
        },
      }),
      decisionId,
    );
  }
}
const authoritySchema = z.object({
  __workflowStageReview: z.strictObject({
    reviewId: IdSchema,
    proposalHash: z.string(),
    stageId: IdSchema,
    evidenceMessageId: IdSchema,
    confidence: z.number().finite().min(0).max(1),
    provider: z.literal('jev'),
    model: z.string().min(1),
  }),
});
/** Native settlement provenance is necessary; workflow stage authority must also be Jev-owned. */
export function validateWorkflowStageReview(ctx: Ctx, reviewId: Id, p: ReviewProposal): void {
  if (p.kind === 'move') {
    if (
      ctx.db.get(
        'SELECT w.id FROM workflow_config w WHERE w.lane_id=(SELECT lane_id FROM card WHERE id=?) OR w.lane_id=(SELECT lane_id FROM stage WHERE id=?)',
        p.cardId,
        p.toStageId,
      )
    )
      validateSettlement(ctx, reviewId, p, true);
    return;
  }
  if (p.kind !== 'new_card' || !p.move) return;
  const config = ctx.db.get<{ confidence_threshold: number }>(
    'SELECT confidence_threshold FROM workflow_config WHERE lane_id=?',
    p.laneId,
  );
  if (!config) return;
  const latest = ctx.db.get<{ raw: string }>(
    'SELECT d.raw FROM decision d JOIN review_message rm ON rm.decision_id=d.id WHERE rm.review_item_id=? ORDER BY d.id DESC LIMIT 1',
    reviewId,
  );
  const parsed = authoritySchema.safeParse(JSON.parse(latest?.raw ?? '{}'));
  if (!parsed.success) throw new AppError('conflict', 'Workflow stage requires retained Jev authority');
  const a = parsed.data.__workflowStageReview;
  if (
    a.reviewId !== reviewId ||
    a.proposalHash !== digest(p) ||
    a.stageId !== p.move.toStageId ||
    a.confidence <= config.confidence_threshold ||
    !ctx.db.get(
      "SELECT s.id FROM stage s JOIN workflow_stage w ON w.stage_id=s.id JOIN lane l ON l.id=s.lane_id WHERE s.id=? AND s.lane_id=? AND s.removed_at IS NULL AND l.archived_at IS NULL AND w.key IN ('work_in_progress','integrations','completed')",
      a.stageId,
      p.laneId,
    )
  )
    throw new AppError('conflict', 'Workflow stage authority changed');
  const source = ctx.db.get<{ chat_id: Id }>(
    'SELECT m.chat_id FROM message m JOIN review_message rm ON rm.message_id=m.id JOIN identity i ON i.id=m.sender_identity_id WHERE rm.review_item_id=? AND m.id=? AND m.deleted_at IS NULL AND i.teammate_id IS NULL',
    reviewId,
    a.evidenceMessageId,
  );
  if (!source || !eligibleChat(ctx, source.chat_id))
    throw new AppError('conflict', 'Workflow stage evidence is unavailable');
}
