import { createHash } from 'node:crypto';
import { attachMessage, createCard, moveCard } from '../board/index.ts';
import type {
  Ctx,
  Db,
  Id,
  Model,
  MovementDecisionProvider,
  MovementRequest,
  OpLog,
  Pipeline,
} from '../contracts/index.ts';
import { AppError, ModelDecisionSchema, MovementResultSchema, ReviewProposalSchema } from '../contracts/index.ts';
import { record } from '../log/index.ts';
import { spineActions } from './spine-actions.ts';
import { spineInput } from './spine-input.ts';

export function createPipeline(deps: {
  db: Db;
  model: Model;
  movement: MovementDecisionProvider;
  now(): Date;
  sleep(ms: number): Promise<void>;
  oplog: OpLog;
}): Pipeline {
  const { db, now, model, movement } = deps;
  const ctx: Ctx = { db, now, actor: { kind: 'agent' }, canReadText: true };
  let running = false;
  let stopped = false;
  let loop: Promise<void> | null = null;
  let active: Promise<Id | null> | null = null;
  let controller: AbortController | null = null;
  let since: string | null = null;
  function pending(): number {
    return (
      db.get<{ n: number }>('SELECT count(*) AS n FROM message WHERE processed_version<version AND deleted_at IS NULL')
        ?.n ?? 0
    );
  }
  const pipeline: Pipeline = {
    start() {
      if (running) return;
      running = true;
      stopped = false;
      since = now().toISOString();
      loop = (async () => {
        while (running) {
          const id = await pipeline.processNext();
          if (id === null && running) await deps.sleep(1000);
        }
      })().catch(() => {
        running = false;
        deps.oplog('error', 'pipeline.stopped', { code: 'spine_failed' });
      });
    },
    async stop() {
      stopped = true;
      running = false;
      controller?.abort();
      await loop;
      await active;
      loop = null;
      since = null;
    },
    async processNext() {
      if (active) {
        await active;
        return pipeline.processNext();
      }
      if (stopped || model.blocked) return null;
      active = (async () => {
        const next = db.get<{
          id: Id;
          version: number;
        }>(`SELECT m.id,m.version FROM message m JOIN chat ch ON ch.id=m.chat_id WHERE m.processed_version<m.version AND m.deleted_at IS NULL AND ch.withdrawn_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM account_chat ac WHERE ac.chat_id=m.chat_id AND ac.sync_state<>'idle')
         AND NOT EXISTS (SELECT 1 FROM message older WHERE older.chat_id=m.chat_id AND older.processed_version<older.version AND older.deleted_at IS NULL AND (older.sent_at<m.sent_at OR (older.sent_at=m.sent_at AND older.id<m.id))) ORDER BY CASE m.origin WHEN 'live' THEN 0 ELSE 1 END,m.sent_at,m.id LIMIT 1`);
        if (!next) return null;
        const input = spineInput(ctx, next.id);
        controller = new AbortController();
        const raw = await model.decide(input, controller.signal);
        if (stopped || controller.signal.aborted) return null;
        const parsed = ModelDecisionSchema.safeParse(raw);
        if (!parsed.success) throw new AppError('invalid', 'Invalid spine model decision');
        const d = parsed.data;
        if (d.disposition === 'create' || d.disposition === 'attach' || d.disposition === 'join') {
          const subjectLane =
            d.laneId ??
            input.cards.find((c) => c.id === d.cardId)?.laneId ??
            input.proposals.find((p) => p.id === d.proposalId)?.laneId;
          const l = input.lanes.find((l) => l.id === subjectLane);
          if (!l) throw new AppError('invalid', 'Unknown subject lane');
          const stage = input.cards.find((c) => c.id === d.cardId)?.stageId ?? l.stages[0]?.id;
          if (stage === undefined) throw new AppError('invalid', 'Missing initial stage');
          const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
          const options = input.lanes
            .filter((other) => other.id !== l.id)
            .flatMap((other) =>
              other.stages.map((s) => ({
                id: `lane:${other.id}:v:${other.version}:stage:${s.id}:criterion:${digest(s.criteria)}`,
                toLaneId: other.id,
                toStageId: s.id,
                laneVersion: other.version,
                criterionId: `stage:${s.id}:v:${other.version}:${digest(s.criteria)}`,
                criterionLabel: s.position === 0 ? other.sop : s.criteria,
              })),
            );
          const request: MovementRequest = {
            schemaVersion: 1,
            requestId: `spine:${next.id}:${next.version}`,
            snapshotHash: digest({ messageId: next.id, version: next.version, lane: l.id, stage }),
            message: { id: next.id, key: input.message.key, version: next.version, chatId: input.chat.id },
            subject:
              d.disposition === 'create'
                ? { kind: 'new_card', openedByMessageKey: input.message.key }
                : d.disposition === 'join'
                  ? {
                      kind: 'proposal',
                      proposalId: d.proposalId as Id,
                      openedByMessageKey:
                        input.proposals.find((p) => p.id === d.proposalId)?.openedByMessageKey ?? input.message.key,
                    }
                  : { kind: 'card', cardId: d.cardId as Id },
            current: {
              laneId: l.id,
              stageId: stage,
              laneVersion: l.version,
              title:
                d.title ??
                input.cards.find((c) => c.id === d.cardId)?.title ??
                input.proposals.find((p) => p.id === d.proposalId)?.title ??
                '',
              summary: d.summary ?? '',
              stageHumanSetAt: null,
            },
            lanes: input.lanes,
            options,
            evidence: [
              {
                id: next.id,
                key: input.message.key,
                version: next.version,
                sentAt: input.message.sentAt,
                text: input.message.text,
                media: input.message.media,
                replyToId: input.message.replyToId,
              },
            ],
            evidenceOptions: [{ id: `message:${next.id}:v:${next.version}`, messageIds: [next.id] }],
          };
          const result = MovementResultSchema.parse(await movement.decide(request, controller.signal));
          if (stopped || controller.signal.aborted) return null;
          if (result.requestId !== request.requestId || result.snapshotHash !== request.snapshotHash)
            throw new AppError('invalid', 'Movement replay correlation differs');
          if (result.kind === 'failed' || (result.kind === 'answered' && result.movement.choice !== 'stay'))
            throw new AppError('invalid', 'not built: processNext');
        }
        if (stopped) return null;
        return db.tx(() => {
          const current = db.get<{
            version: number;
            processed_version: number;
            withdrawn_at: string | null;
            deleted_at: string | null;
          }>(
            'SELECT m.version,m.processed_version,m.deleted_at,ch.withdrawn_at FROM message m JOIN chat ch ON ch.id=m.chat_id WHERE m.id=?',
            next.id,
          );
          if (
            !current ||
            current.version !== next.version ||
            current.processed_version >= next.version ||
            current.deleted_at !== null ||
            current.withdrawn_at !== null
          )
            return null;
          const decisionId = db.run(
            "INSERT INTO decision(message_id,message_version,outcome,disposition,confidence,reason,lane_versions,model,raw,decided_at) VALUES (?,?,'none',?,?,?,?,?,?,?)",
            next.id,
            next.version,
            d.disposition,
            d.confidence,
            d.reason,
            JSON.stringify(Object.fromEntries(input.lanes.map((l) => [l.id, l.version]))),
            model.name,
            JSON.stringify(raw),
            now().toISOString(),
          ).lastInsertRowid;
          const outcome = spineActions(ctx, spineInput(ctx, next.id), d, decisionId);
          db.run('UPDATE decision SET outcome=? WHERE id=?', outcome, decisionId);
          db.run('UPDATE message SET processed_version=? WHERE id=?', next.version, next.id);
          return next.id;
        });
      })();
      try {
        return await active;
      } catch (error) {
        if (stopped || controller?.signal.aborted) return null;
        throw error;
      } finally {
        active = null;
        controller = null;
      }
    },
    async drain() {
      let count = 0;
      while ((await pipeline.processNext()) !== null) count++;
      return count;
    },
    status() {
      return {
        state: model.blocked ? 'blocked' : running ? 'running' : 'stopped',
        reason: model.blocked,
        since,
        pending: pending(),
        movement: movement.status(),
        modelFailure: null,
      };
    },
  };
  return pipeline;
}
export function acceptReview(ctx: Ctx, id: Id): void {
  if (ctx.actor.kind !== 'teammate') throw new AppError('forbidden', 'Teammate required');
  ctx.db.tx(() => {
    const row = ctx.db.get<{ kind: string; proposal: string; status: string }>(
      'SELECT kind,proposal,status FROM review_item WHERE id=?',
      id,
    );
    if (!row) throw new AppError('not_found', 'Review not found');
    if (row.kind !== 'new_card') throw new AppError('invalid', 'not built: acceptReview');
    if (row.status !== 'open') throw new AppError('conflict', 'Review already settled');
    const proposal = ReviewProposalSchema.parse(JSON.parse(row.proposal));
    if (proposal.kind !== 'new_card') throw new AppError('invalid', 'Invalid new-card proposal');
    const messages = ctx.db.all<{
      id: Id;
      chat_id: Id;
      origin: string;
      deleted_at: string | null;
      withdrawn_at: string | null;
    }>(
      'SELECT m.id,m.chat_id,m.origin,m.deleted_at,ch.withdrawn_at FROM review_message rm JOIN message m ON m.id=rm.message_id JOIN chat ch ON ch.id=m.chat_id WHERE rm.review_item_id=? ORDER BY m.sent_at,m.id',
      id,
    );
    if (!messages.length || messages.some((m) => m.deleted_at !== null || m.withdrawn_at !== null))
      throw new AppError('conflict', 'Review evidence is unavailable');
    if (
      proposal.move !== null &&
      !ctx.db.get(
        'SELECT id FROM stage WHERE id=? AND lane_id=? AND removed_at IS NULL',
        proposal.move.toStageId,
        proposal.laneId,
      )
    )
      throw new AppError('invalid', 'Cross-lane movement is outside spine');
    const first = messages[0] as { id: Id; chat_id: Id; origin: string };
    const card = createCard(
      ctx,
      {
        laneId: proposal.laneId,
        title: proposal.title,
        summary: proposal.summary,
        companyId: proposal.companyId,
        chatId: first.chat_id,
        messageId: first.id,
        fromHistory: first.origin === 'history',
      },
      { setBy: 'human' },
    );
    for (const message of messages.slice(1)) attachMessage(ctx, message.id, card.id, { setBy: 'human' });
    if (proposal.move !== null)
      moveCard(
        ctx,
        card.id,
        {
          stageId: proposal.move.toStageId,
          criterion: proposal.move.criterion,
          evidenceMessageIds: messages.map((m) => m.id),
        },
        { setBy: 'human' },
      );
    ctx.db.run(
      "UPDATE review_item SET status='accepted',result_card_id=?,resolved_by=?,resolved_at=?,updated_at=? WHERE id=?",
      card.id,
      ctx.actor.kind === 'teammate' ? ctx.actor.id : null,
      ctx.now().toISOString(),
      ctx.now().toISOString(),
      id,
    );
    record(ctx, {
      action: 'review.accept',
      subjectKind: 'review',
      subjectId: id,
      after: { cardId: card.id },
      messageIds: messages.map((m) => m.id),
    });
  });
}
