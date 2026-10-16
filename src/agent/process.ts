import type {
  Ctx,
  DecideInput,
  Id,
  ModelDecision,
  MovementRequest,
  MovementResult,
  Outcome,
  ReviewProposal,
} from '../contracts/index.ts';
import { ReviewProposalSchema } from '../contracts/index.ts';
import { normalizeCompanyName } from '../graph/index.ts';
import { record } from '../log/index.ts';
import { applyOwnedAction } from './apply.ts';
import { judge, moveOutcome, readGuardFacts } from './guard.ts';
import { writeAudit } from './movement/audit.ts';
import { movementGate } from './movement/subject.ts';
import { addReview, joinProposal } from './review-groups.ts';
import { bindReviewState, type ReviewSource } from './review-state.ts';

export function commitDecision(
  ctx: Ctx,
  input: DecideInput,
  raw: unknown,
  d: ModelDecision,
  model: string,
  request: MovementRequest | null,
  result: MovementResult | null,
  sources: ReviewSource[],
): Id {
  const decisionId = ctx.db.run(
    "INSERT INTO decision(message_id,message_version,outcome,disposition,confidence,reason,lane_versions,model,raw,decided_at) VALUES (?,?,'none',?,?,?,?,?,?,?)",
    input.message.id,
    input.message.version,
    d.disposition,
    d.confidence,
    d.reason,
    JSON.stringify(Object.fromEntries(input.lanes.map((l) => [l.id, l.version]))),
    model,
    JSON.stringify(raw),
    ctx.now().toISOString(),
  ).lastInsertRowid;
  const facts = readGuardFacts(ctx.db, input.message.id, d),
    gate = request && result ? movementGate(ctx, request, result) : null;
  const sourceLane = request?.current.laneId ?? d.laneId ?? input.cards.find((c) => c.id === d.cardId)?.laneId;
  const genericTargetLane = input.lanes.find((l) => l.stages.some((s) => s.id === d.move?.toStageId))?.id;
  const genericCrossLane =
    d.move !== null && genericTargetLane !== undefined && sourceLane !== undefined && genericTargetLane !== sourceLane;
  const effective = { ...d, move: genericCrossLane || (gate && gate.kind !== 'release') ? null : d.move };
  const outcomes = judge(effective, facts);
  let cardId: Id | null = null,
    proposalId: Id | null = null,
    auditReviewId: Id | null = null,
    applied = 0,
    reviewed = 0,
    refused = 0;
  function outcome(o: Outcome): void {
    if (o.do === 'apply') {
      const id = applyOwnedAction(ctx, o.action, {
        decisionId,
        reason: d.reason,
        setBy: 'agent',
        followsHumanOverride: o.followsHumanOverride,
      });
      if (['card.create', 'message.attach'].includes(o.action.type)) cardId = id;
      applied++;
    } else if (o.do === 'review') {
      let p = o.proposal;
      if (p.kind === 'new_card' && gate?.kind === 'target')
        p = { ...p, move: { toStageId: gate.option.toStageId, criterion: gate.reason } };
      else if (p.kind === 'new_card' && effective.move) {
        const stage = facts.stages.find((s) => s.id === effective.move?.toStageId);
        if (stage?.laneId === p.laneId)
          p = { ...p, move: { toStageId: stage.id, criterion: effective.move.criterion } };
      }
      const id = addReview(
        ctx,
        { ...o, why: p.kind === 'new_card' && gate?.kind === 'target' ? 'cross_lane' : o.why, proposal: p },
        [input.message.id],
        decisionId,
        p.kind === 'new_card' && gate?.kind === 'target' ? gate.reason : d.reason,
      );
      reviewed++;
      if (p.kind === 'new_card') {
        proposalId = id;
        if (gate?.kind === 'target') auditReviewId = id;
      }
    } else if (o.do === 'pending_mention')
      ctx.db.run(
        'INSERT INTO pending_mention(message_id,name,name_norm,confidence,created_at) VALUES (?,?,?,?,?) ON CONFLICT(message_id,name_norm) DO UPDATE SET name=excluded.name,confidence=excluded.confidence',
        input.message.id,
        o.name,
        normalizeCompanyName(o.name),
        o.confidence,
        ctx.now().toISOString(),
      );
    else {
      record(ctx, {
        action: 'agent.refused',
        subjectKind: 'message',
        subjectId: input.message.id,
        reason: o.why,
        messageIds: [input.message.id],
        decisionId,
      });
      addReview(
        ctx,
        {
          do: 'review',
          kind: 'model_failed',
          groupKey: `chat:${input.chat.id}:guard`,
          chatId: input.chat.id,
          why: 'model_failed',
          proposal: { kind: 'model_failed' },
          confidence: 0,
        },
        [input.message.id],
        decisionId,
        o.why,
      );
      reviewed++;
      refused++;
    }
  }
  for (const o of outcomes) outcome(o);
  if (genericCrossLane) outcome({ do: 'refuse', why: 'invalid_move' });
  if (d.disposition === 'join' && d.proposalId !== null && !outcomes.some((o) => o.do === 'refuse')) {
    const row = ctx.db.get<{ status: string; proposal: string; result_card_id: Id | null }>(
      'SELECT status,proposal,result_card_id FROM review_item WHERE id=?',
      d.proposalId,
    );
    if (row?.status === 'open') {
      const p = ReviewProposalSchema.parse(JSON.parse(row.proposal));
      if (p.kind === 'new_card') {
        let move: Extract<ReviewProposal, { kind: 'new_card' }>['move'] = null;
        if (gate?.kind === 'target') move = { toStageId: gate.option.toStageId, criterion: gate.reason };
        else if ((gate === null || gate.kind === 'release') && d.move) {
          const stage = facts.stages.find((s) => s.id === d.move?.toStageId);
          if (stage?.laneId === p.laneId) move = { toStageId: stage.id, criterion: d.move.criterion };
        }
        joinProposal(
          ctx,
          d.proposalId,
          input.message.id,
          decisionId,
          d.summary,
          move,
          gate?.kind === 'target' ? gate.reason : d.reason,
          gate?.kind === 'target' ? 'cross_lane' : 'low_confidence',
          gate?.kind === 'target' ? gate.confidence : d.confidence,
        );
        proposalId = d.proposalId;
        reviewed++;
        if (gate?.kind === 'target') auditReviewId = proposalId;
      }
    } else cardId = row?.result_card_id ?? cardId;
  }
  // The first real-ID move validation uses the same rule as ordinary card moves.
  if (d.disposition === 'create' && cardId !== null && effective.move)
    outcome(
      moveOutcome(effective.move, cardId, readGuardFacts(ctx.db, input.message.id, { ...effective, cardId }), true),
    );
  if (gate?.kind === 'target' && proposalId === null) {
    const targetCard = cardId ?? (d.disposition === 'attach' ? d.cardId : null);
    if (targetCard !== null) {
      auditReviewId = addReview(
        ctx,
        {
          do: 'review',
          kind: 'move',
          groupKey: `card:${targetCard}`,
          chatId: input.chat.id,
          why: 'cross_lane',
          proposal: { kind: 'move', cardId: targetCard, toStageId: gate.option.toStageId, criterion: gate.reason },
          confidence: gate.confidence,
        },
        [input.message.id, ...gate.ids],
        decisionId,
        gate.reason,
      );
      reviewed++;
    }
  }
  if (gate?.kind === 'review') {
    addReview(
      ctx,
      {
        do: 'review',
        kind: 'model_failed',
        groupKey: `chat:${input.chat.id}`,
        chatId: input.chat.id,
        why: 'model_failed',
        proposal: { kind: 'model_failed' },
        confidence: gate.confidence,
      },
      [input.message.id],
      decisionId,
      gate.code,
    );
    reviewed++;
  }
  if (request && result && gate)
    writeAudit(
      ctx,
      decisionId,
      request,
      result,
      gate,
      auditReviewId,
      cardId ?? (request.subject.kind === 'card' ? request.subject.cardId : null),
    );
  bindReviewState(ctx, decisionId, sources);
  ctx.db.run(
    'UPDATE decision SET outcome=? WHERE id=?',
    applied ? (reviewed ? 'mixed' : 'applied') : reviewed ? 'review' : refused ? 'refused' : 'none',
    decisionId,
  );
  ctx.db.run('UPDATE message SET processed_version=? WHERE id=?', input.message.version, input.message.id);
  return input.message.id;
}

export function commitFailure(ctx: Ctx, input: DecideInput, code: string, model: string): Id {
  const id = ctx.db.run(
    "INSERT INTO decision(message_id,message_version,outcome,disposition,confidence,reason,lane_versions,model,raw,decided_at) VALUES (?,?,'failed','none',0,?,?,?,?,?)",
    input.message.id,
    input.message.version,
    code,
    JSON.stringify(Object.fromEntries(input.lanes.map((l) => [l.id, l.version]))),
    model,
    JSON.stringify({ failure: code }),
    ctx.now().toISOString(),
  ).lastInsertRowid;
  addReview(
    ctx,
    {
      do: 'review',
      kind: 'model_failed',
      groupKey: `chat:${input.chat.id}`,
      chatId: input.chat.id,
      why: 'model_failed',
      proposal: { kind: 'model_failed' },
      confidence: 0,
    },
    [input.message.id],
    id,
    code,
  );
  record(ctx, {
    action: 'agent.refused',
    subjectKind: 'message',
    subjectId: input.message.id,
    reason: code,
    messageIds: [input.message.id],
    decisionId: id,
  });
  ctx.db.run('UPDATE message SET processed_version=? WHERE id=?', input.message.version, input.message.id);
  return input.message.id;
}
