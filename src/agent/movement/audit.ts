import { z } from 'zod';
import type { Ctx, Id, MovementRequest, MovementResult, ReviewProposal } from '../../contracts/index.ts';
import { AppError, MovementResultSchema } from '../../contracts/index.ts';
import { digest } from '../json.ts';
import { eligibleChat } from '../selection.ts';
import type { MovementGate } from './subject.ts';

function cardState(ctx: Ctx, id: Id) {
  return ctx.db.get(
    'SELECT id,lane_id,stage_id,text_set_by,company_id,company_set_by,stage_human_set_at,archived_at,needs_text FROM card WHERE id=?',
    id,
  );
}
function configState(ctx: Ctx, ids: Id[]) {
  return ids.map((id) => ({
    id,
    version:
      ctx.db.get<{ version: number }>('SELECT version FROM lane WHERE id=? AND archived_at IS NULL', id)?.version ??
      null,
    stages: ctx.db.all(
      'SELECT id,position,criteria FROM stage WHERE lane_id=? AND removed_at IS NULL ORDER BY position,id',
      id,
    ),
  }));
}
export function writeAudit(
  ctx: Ctx,
  decisionId: Id,
  r: MovementRequest,
  result: MovementResult,
  gate: MovementGate,
  reviewItemId: Id | null,
  cardId: Id | null,
): void {
  const proposal =
    reviewItemId === null
      ? null
      : (ctx.db.get<{ proposal: string }>('SELECT proposal FROM review_item WHERE id=?', reviewItemId)?.proposal ??
        null);
  const snapshot = {
    requestId: r.requestId,
    snapshotHash: r.snapshotHash,
    subject: r.subject,
    message: r.message,
    current: {
      laneId: r.current.laneId,
      stageId: r.current.stageId,
      laneVersion: r.current.laneVersion,
      stageHumanSetAt: r.current.stageHumanSetAt,
      textDigest: digest([r.current.title, r.current.summary]),
    },
    options: r.options.map((o) => ({ ...o, criterionLabel: undefined })),
    laneIds: r.lanes.map((l) => l.id),
    evidence: r.evidence.map((e) => ({ id: e.id, version: e.version, chatId: r.message.chatId })),
    citations: r.evidence
      .filter((e) => gate.kind === 'target' && gate.ids.includes(e.id))
      .map((e) => ({ id: e.id, version: e.version, chatId: r.message.chatId })),
    settlement: {
      reviewItemId,
      proposalDigest: proposal === null ? null : digest(JSON.parse(proposal)),
      cardId,
      cardDigest: cardId === null ? null : digest(cardState(ctx, cardId)),
      configDigest: digest(
        configState(
          ctx,
          r.lanes.map((l) => l.id),
        ),
      ),
    },
  };
  const parsed = MovementResultSchema.safeParse(result);
  const safe =
    parsed.success && !(gate.kind === 'review' && ['invalid_response', 'context_limit', 'stale'].includes(gate.code))
      ? parsed.data
      : {
          provider: 'jev',
          execution: 'disabled',
          configuredModel: null,
          providerRequestId: null,
          schemaVersion: 1,
          requestId: r.requestId,
          snapshotHash: r.snapshotHash,
          kind: 'failed',
          code: 'invalid_response',
        };
  const normalized = {
    ...safe,
    target: gate.kind === 'target' ? gate.option : null,
    supportingMessageIds: gate.kind === 'target' ? gate.ids : [],
    reason: gate.kind === 'target' ? gate.reason : null,
    gateCode: gate.kind === 'review' ? gate.code : null,
  };
  ctx.db.run(
    'INSERT INTO movement_decision(decision_id,schema_version,status,snapshot,result) VALUES (?,1,?,?,?)',
    decisionId,
    gate.kind === 'target'
      ? 'transition'
      : gate.kind === 'review'
        ? gate.code === 'stale'
          ? 'stale'
          : safe.kind === 'failed'
            ? 'failed'
            : 'review'
        : 'stay',
    JSON.stringify(snapshot),
    JSON.stringify(normalized),
  );
}
const auditSchema = z.object({
  message: z.object({ chatId: z.number() }),
  evidence: z.array(z.object({ id: z.number(), version: z.number(), chatId: z.number() })),
  citations: z.array(z.object({ id: z.number(), version: z.number(), chatId: z.number() })),
  laneIds: z.array(z.number()),
  options: z.array(z.object({ toLaneId: z.number(), toStageId: z.number(), laneVersion: z.number() })),
  settlement: z.object({
    reviewItemId: z.number().nullable(),
    proposalDigest: z.string().nullable(),
    cardId: z.number().nullable(),
    cardDigest: z.string().nullable(),
    configDigest: z.string(),
  }),
});
export function validateSettlement(ctx: Ctx, reviewId: Id, proposal: ReviewProposal, requireAuthority = false): void {
  const stageId =
    proposal.kind === 'move' ? proposal.toStageId : proposal.kind === 'new_card' ? proposal.move?.toStageId : null;
  if (stageId == null) return;
  const lane = ctx.db.get<{ lane_id: Id }>(
    'SELECT s.lane_id FROM stage s JOIN lane l ON l.id=s.lane_id WHERE s.id=? AND s.removed_at IS NULL AND l.archived_at IS NULL',
    stageId,
  );
  if (!lane) throw new AppError('conflict', 'Review destination is unavailable');
  const sourceLane =
    proposal.kind === 'new_card'
      ? proposal.laneId
      : proposal.kind === 'move'
        ? ctx.db.get<{ lane_id: Id }>('SELECT lane_id FROM card WHERE id=?', proposal.cardId)?.lane_id
        : null;
  const rows = ctx.db.all<{ snapshot: string; result: string }>(
    "SELECT md.snapshot,md.result FROM movement_decision md JOIN review_message rm ON rm.decision_id=md.decision_id WHERE rm.review_item_id=? AND md.status='transition' ORDER BY md.decision_id DESC",
    reviewId,
  );
  const candidate = rows.find((a) => {
    const p = auditSchema.safeParse(JSON.parse(a.snapshot));
    return (
      p.success && p.data.settlement.reviewItemId === reviewId && p.data.settlement.proposalDigest === digest(proposal)
    );
  });
  if (!candidate) {
    if (requireAuthority) throw new AppError('conflict', 'Workflow stage requires retained Jev authority');
    if (sourceLane !== lane.lane_id) throw new AppError('conflict', 'Cross-lane review provenance is unavailable');
    return;
  }
  const a = auditSchema.parse(JSON.parse(candidate.snapshot));
  const normalized = JSON.parse(candidate.result);
  const { target, supportingMessageIds, reason: _reason, gateCode: _gateCode, ...answer } = normalized;
  const parsedAnswer = MovementResultSchema.safeParse(answer);
  if (
    !parsedAnswer.success ||
    parsedAnswer.data.kind !== 'answered' ||
    parsedAnswer.data.movement.choice !== target?.id ||
    parsedAnswer.data.supportTarget !== target.id ||
    parsedAnswer.data.supportQuestionId !== `support:${target.id}` ||
    !Array.isArray(supportingMessageIds) ||
    !supportingMessageIds.length ||
    target.toStageId !== stageId ||
    target.toLaneId !== lane.lane_id
  )
    throw new AppError('conflict', 'Review movement correlation is unavailable');
  const option = a.options.find((o) => o.toStageId === stageId && o.toLaneId === lane.lane_id);
  if (
    !option ||
    ctx.db.get<{ version: number }>('SELECT version FROM lane WHERE id=?', lane.lane_id)?.version !== option.laneVersion
  )
    throw new AppError('conflict', 'Review SOP changed');
  if (a.settlement.cardId !== null && digest(cardState(ctx, a.settlement.cardId)) !== a.settlement.cardDigest)
    throw new AppError('conflict', 'Review card changed');
  if (digest(configState(ctx, a.laneIds)) !== a.settlement.configDigest)
    throw new AppError('conflict', 'Review configuration changed');
  for (const audit of rows) {
    const parsed = auditSchema.safeParse(JSON.parse(audit.snapshot));
    if (!parsed.success) throw new AppError('conflict', 'Review evidence provenance is unavailable');
    for (const e of parsed.data.citations) {
      const m = ctx.db.get<{ version: number; chat_id: Id; deleted_at: string | null }>(
        'SELECT version,chat_id,deleted_at FROM message WHERE id=?',
        e.id,
      );
      if (
        !m ||
        m.version !== e.version ||
        m.chat_id !== e.chatId ||
        m.deleted_at !== null ||
        !eligibleChat(ctx, e.chatId)
      )
        throw new AppError('conflict', 'Review evidence changed');
    }
  }
}
