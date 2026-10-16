import { getSetting } from '../../auth/index.ts';
import type { Ctx, DecideInput, ModelDecision, MovementRequest, MovementResult } from '../../contracts/index.ts';
import { MovementResultSchema, ReviewProposalSchema } from '../../contracts/index.ts';
import { digest } from '../json.ts';
import { boundRequest, choice } from './wire.ts';

export function movementRequest(ctx: Ctx, input: DecideInput, d: ModelDecision): MovementRequest | null {
  let subject: MovementRequest['subject'],
    laneId: number,
    stageId: number,
    title: string,
    summary: string,
    stageHumanSetAt: string | null = null;
  let priorIds: number[] = [];
  if (d.disposition === 'create' && d.laneId !== null && d.title !== null && d.summary !== null) {
    const lane = input.lanes.find((l) => l.id === d.laneId),
      stage = lane?.stages[0];
    if (!lane || !stage) return null;
    subject = { kind: 'new_card', openedByMessageKey: input.message.key };
    laneId = lane.id;
    stageId = stage.id;
    title = d.title;
    summary = d.summary;
  } else {
    let cardId = d.cardId;
    if (d.disposition === 'join' && d.proposalId !== null) {
      const r = ctx.db.get<{ proposal: string; status: string; result_card_id: number | null }>(
        'SELECT proposal,status,result_card_id FROM review_item WHERE id=? AND chat_id=?',
        d.proposalId,
        input.chat.id,
      );
      if (!r) return null;
      if (r.status === 'open') {
        const p = ReviewProposalSchema.parse(JSON.parse(r.proposal)),
          offered = input.proposals.find((p) => p.id === d.proposalId);
        if (p.kind !== 'new_card' || !offered) return null;
        const lane = input.lanes.find((l) => l.id === p.laneId),
          stage = lane?.stages[0];
        if (!lane || !stage) return null;
        subject = { kind: 'proposal', proposalId: d.proposalId, openedByMessageKey: offered.openedByMessageKey };
        laneId = lane.id;
        stageId = stage.id;
        title = p.title;
        summary = d.summary ?? p.summary;
        priorIds = ctx.db
          .all<{ id: number }>('SELECT message_id AS id FROM review_message WHERE review_item_id=?', d.proposalId)
          .map((m) => m.id);
        return finish(subject, laneId, stageId, title, summary, stageHumanSetAt, priorIds);
      }
      cardId = r.result_card_id;
    }
    if (cardId === null || !['attach', 'join'].includes(d.disposition)) return null;
    const card = input.cards.find((c) => c.id === cardId && c.link === 'this_chat');
    if (!card) return null;
    const extra = ctx.db.get<{ stage_human_set_at: string | null }>(
      'SELECT stage_human_set_at FROM card WHERE id=?',
      card.id,
    );
    if (!extra) return null;
    subject = { kind: 'card', cardId: card.id };
    laneId = card.laneId;
    stageId = card.stageId;
    title = card.title;
    summary = card.summary;
    stageHumanSetAt = extra.stage_human_set_at;
    priorIds = ctx.db
      .all<{ id: number }>('SELECT message_id AS id FROM card_message WHERE card_id=?', card.id)
      .map((m) => m.id);
  }
  return finish(subject, laneId, stageId, title, summary, stageHumanSetAt, priorIds);
  function finish(
    subject: MovementRequest['subject'],
    laneId: number,
    stageId: number,
    title: string,
    summary: string,
    stageHumanSetAt: string | null,
    prior: number[],
  ): MovementRequest | null {
    const lane = input.lanes.find((l) => l.id === laneId);
    if (!lane) return null;
    const earlier = ctx.db
      .all<{
        id: number;
        key: string;
        version: number;
        sentAt: string;
        text: string;
        media: string | null;
        replyToId: number | null;
      }>(
        `SELECT id,message_key AS key,version,sent_at AS sentAt,text,media,reply_to_message_id AS replyToId FROM message WHERE id IN (SELECT value FROM json_each(?)) AND chat_id=? AND deleted_at IS NULL AND (sent_at<? OR (sent_at=? AND id<?)) ORDER BY sent_at DESC,id DESC LIMIT 20`,
        JSON.stringify(prior),
        input.chat.id,
        input.message.sentAt,
        input.message.sentAt,
        input.message.id,
      )
      .reverse();
    const evidence = [
      ...earlier,
      {
        id: input.message.id,
        key: input.message.key,
        version: input.message.version,
        sentAt: input.message.sentAt,
        text: input.message.text,
        media: input.message.media,
        replyToId: input.message.replyToId,
      },
    ];
    const evidenceOptions = evidence.map((e) => ({ id: `message:${e.id}:v:${e.version}`, messageIds: [e.id] }));
    if (evidence.length > 1)
      evidenceOptions.push({
        id: `all:${digest(evidence.map((e) => [e.id, e.version]).sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0)))}`,
        messageIds: evidence.map((e) => e.id).sort((a, b) => a - b),
      });
    const options = input.lanes
      .filter((l) => l.id !== laneId)
      .flatMap((l) =>
        l.stages.map((s) => {
          const hash = digest(s.position === 0 ? l.sop : s.criteria);
          return {
            id: `lane:${l.id}:v:${l.version}:stage:${s.id}:criterion:${hash}`,
            toLaneId: l.id,
            toStageId: s.id,
            laneVersion: l.version,
            criterionId: `stage:${s.id}:v:${l.version}:${hash}`,
            criterionLabel: s.position === 0 ? l.sop : s.criteria,
          };
        }),
      )
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const r: MovementRequest = {
      schemaVersion: 1,
      requestId: `message:${input.message.id}:v:${input.message.version}`,
      snapshotHash: '',
      message: { id: input.message.id, key: input.message.key, version: input.message.version, chatId: input.chat.id },
      subject,
      current: { laneId, stageId, laneVersion: lane.version, title, summary, stageHumanSetAt },
      lanes: input.lanes,
      options,
      evidence,
      evidenceOptions,
    };
    r.snapshotHash = digest(r);
    return r;
  }
}

export type MovementGate =
  | { kind: 'release' }
  | { kind: 'target'; option: MovementRequest['options'][number]; ids: number[]; confidence: number; reason: string }
  | { kind: 'review'; code: string; confidence: number };
export function movementGate(ctx: Ctx, r: MovementRequest, raw: MovementResult): MovementGate {
  try {
    boundRequest(r);
    const p = MovementResultSchema.safeParse(raw);
    if (!p.success || p.data.requestId !== r.requestId || p.data.snapshotHash !== r.snapshotHash)
      return { kind: 'review', code: 'invalid_response', confidence: 0 };
    const result = p.data;
    if (result.kind === 'failed') return { kind: 'review', code: result.code, confidence: 0 };
    if (result.kind === 'not_requested')
      return r.options.length === 0 ? { kind: 'release' } : { kind: 'review', code: 'stale', confidence: 0 };
    const movement = choice(result.movement, [...r.options.map((o) => o.id), 'stay', 'review']);
    if (movement.choice === 'review')
      return result.support === null && result.supportTarget === null && result.supportQuestionId === null
        ? { kind: 'review', code: 'movement_review_requested', confidence: movement.confidence }
        : { kind: 'review', code: 'invalid_response', confidence: 0 };
    if (
      result.support === null ||
      result.supportTarget !== movement.choice ||
      result.supportQuestionId !== `support:${movement.choice}`
    )
      return { kind: 'review', code: 'invalid_response', confidence: 0 };
    const support = choice(result.support, [...r.evidenceOptions.map((e) => e.id), 'review']);
    const confidence = Math.min(movement.confidence, support.confidence);
    if (support.choice === 'review') return { kind: 'review', code: 'movement_review_requested', confidence };
    const ids = r.evidenceOptions.find((e) => e.id === support.choice)?.messageIds;
    if (!ids?.length) return { kind: 'review', code: 'invalid_response', confidence: 0 };
    if (movement.choice === 'stay')
      return confidence > getSetting<number>(ctx.db, 'review_threshold')
        ? { kind: 'release' }
        : { kind: 'review', code: 'movement_low_confidence', confidence };
    const option = r.options.find((o) => o.id === movement.choice);
    if (!option) return { kind: 'review', code: 'invalid_response', confidence: 0 };
    const lane = r.lanes.find((l) => l.id === option.toLaneId),
      stage = lane?.stages.find((s) => s.id === option.toStageId);
    return {
      kind: 'target',
      option,
      ids: [...ids].sort((a, b) => a - b),
      confidence,
      reason: `Cross-lane proposal: ${lane?.name}/${stage?.name}; SOP v${option.laneVersion}; criterion ${option.criterionLabel}; evidence ${[...ids].sort((a, b) => a - b).join(',')}.`,
    };
  } catch (error) {
    return {
      kind: 'review',
      code: error instanceof Error && error.message === 'context_limit' ? 'context_limit' : 'invalid_response',
      confidence: 0,
    };
  }
}
