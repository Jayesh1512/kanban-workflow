import { attachMessage, createCard, updateCard } from '../board/index.ts';
import type {
  AgentWorkScope,
  Ctx,
  DecideInput,
  Id,
  ModelDecision,
  WorkflowAction,
  WorkflowFields,
  WorkflowInferenceRequest,
  WorkflowInferenceResult,
  WorkflowStage,
} from '../contracts/index.ts';
import { MovementChoiceSchema } from '../contracts/index.ts';
import { record } from '../log/index.ts';
import { addReview } from './review-groups.ts';
import { joinWorkflowProposal } from './workflow-proposals.ts';

export function commitWorkflowInference(
  ctx: Ctx,
  input: DecideInput,
  d: ModelDecision,
  request: WorkflowInferenceRequest,
  result: WorkflowInferenceResult,
  decisionId: Id,
  scope: AgentWorkScope,
  unknown: boolean,
): void {
  const config = ctx.db.get<{ lane_id: Id; automatic: number; confidence_threshold: number }>(
    'SELECT * FROM workflow_config WHERE id=1',
  );
  if (!config) return;
  const review = (reason: string, confidence = 0) => {
    ctx.db.run("UPDATE decision SET outcome='review' WHERE id=?", decisionId);
    if (request.proposal) {
      joinWorkflowProposal(
        ctx,
        request,
        d.summary,
        decisionId,
        `Workflow review: ${reason}; no inferred stage without valid Jev support`,
        confidence,
      );
      return;
    }
    if (
      !request.ticket &&
      d.disposition === 'create' &&
      d.laneId === config.lane_id &&
      d.title?.trim() &&
      d.summary?.trim()
    ) {
      return addReview(
        ctx,
        {
          do: 'review',
          kind: 'new_card',
          groupKey: `workflow:chat:${input.chat.id}`,
          chatId: input.chat.id,
          why: 'low_confidence',
          confidence,
          proposal: {
            kind: 'new_card',
            laneId: config.lane_id,
            title: d.title,
            summary: d.summary,
            companyId: null,
            move: null,
          },
        },
        [input.message.id],
        decisionId,
        `Workflow lead suggestion: ${reason}; starts in To be started, no inferred stage`,
      );
    }
    return addReview(
      ctx,
      {
        do: 'review',
        kind: 'model_failed',
        groupKey: `workflow:${request.ticket?.id ?? `chat:${input.chat.id}`}`,
        chatId: input.chat.id,
        why: 'model_failed',
        confidence,
        proposal: { kind: 'model_failed' },
      },
      [input.message.id],
      decisionId,
      `Workflow review: ${reason}`,
    );
  };
  if (result.kind === 'failed') {
    review(`Jev ${result.code}; no fallback judgment`);
    return;
  }
  if (result.requestId !== request.requestId || result.snapshotHash !== request.snapshotHash) {
    review('stale or uncorrelated Jev response');
    return;
  }
  const values: Record<string, string> = {};
  const ids = new Set<Id>();
  let confidence = 1;
  for (const dimension of ['stage', 'workstream', 'action', 'date', 'buyerId']) {
    const c = result.choices[dimension];
    if (!c || !MovementChoiceSchema.safeParse(c).success || c.choice === 'review') {
      review(`uncertain ${dimension}`);
      return;
    }
    confidence = Math.min(confidence, c.confidence);
    values[dimension] = c.choice;
    if (c.choice === 'none') continue;
    const support = result.supports[`support:${dimension}:${c.choice}`];
    const id = Number(support?.choice.replace(/^message:/, ''));
    if (
      !support ||
      !MovementChoiceSchema.safeParse(support).success ||
      !request.evidence.some((e) => e.id === id) ||
      support.choice !== `message:${id}`
    ) {
      review(`missing evidence for ${dimension}`);
      return;
    }
    confidence = Math.min(confidence, support.confidence);
    ids.add(id);
    const candidate =
      dimension === 'date'
        ? request.dates.find((a) => a.id === c.choice)
        : dimension === 'buyerId'
          ? request.buyerIds.find((a) => a.id === c.choice)
          : null;
    if ((dimension === 'date' || dimension === 'buyerId') && (!candidate || candidate.messageId !== id)) {
      review(`invalid ${dimension} evidence`);
      return;
    }
  }
  let stage = values.stage as Exclude<WorkflowStage, 'archive'>;
  if (stage === 'to_be_started' && request.ticket && request.ticket.stage !== 'to_be_started')
    stage = request.ticket.stage as Exclude<WorkflowStage, 'archive'>;
  const rank: Record<string, number> = { to_be_started: 0, work_in_progress: 1, integrations: 2, completed: 3 };
  // A later outreach or silence signal never regresses proven engagement.
  if (request.ticket && (rank[stage] ?? -1) < (rank[request.ticket.stage] ?? -1) && stage !== 'blocked')
    stage = request.ticket.stage as Exclude<WorkflowStage, 'archive'>;
  const target = ctx.db.get<{ stage_id: Id }>(
    'SELECT w.stage_id FROM workflow_stage w JOIN stage s ON s.id=w.stage_id JOIN lane l ON l.id=s.lane_id WHERE w.key=? AND s.removed_at IS NULL AND l.archived_at IS NULL AND s.lane_id=?',
    stage,
    config.lane_id,
  );
  if (
    !target ||
    !['buyer', 'provider', 'integration', 'others'].includes(values.workstream ?? '') ||
    ![
      'outreach',
      'follow_up',
      'engineering_assessment',
      'run_test',
      'confirm_live',
      'resolve_blocker',
      'none',
    ].includes(values.action ?? '')
  ) {
    review('unoffered result');
    return;
  }
  if (!config.automatic || confidence <= config.confidence_threshold) {
    review('confidence does not strictly exceed workflow threshold', confidence);
    return;
  }
  const link = ctx.db.get<{ set_by: string; card_id: Id | null }>(
    'SELECT * FROM card_message WHERE message_id=?',
    input.message.id,
  );
  if (link?.set_by === 'human') {
    review('human attachment override', confidence);
    return;
  }
  if (
    !request.ticket &&
    !request.proposal &&
    (d.disposition !== 'create' ||
      d.confidence <= config.confidence_threshold ||
      d.laneId !== config.lane_id ||
      !d.title?.trim() ||
      !d.summary?.trim() ||
      stage === 'to_be_started' ||
      values.action === 'outreach' ||
      d.proposalId !== null ||
      ctx.db.get(
        "SELECT id FROM review_item WHERE chat_id=? AND (kind='new_card' OR status IN ('dismissed','changed'))",
        input.chat.id,
      ))
  ) {
    review('unlinked chat requires explicit ticket or substantive new-work review', confidence);
    return;
  }
  if (
    request.ticket &&
    ctx.db.get<{ workflow_version: number }>('SELECT workflow_version FROM card WHERE id=?', request.ticket.id)
      ?.workflow_version !== request.ticket.version
  ) {
    review('stale ticket version', confidence);
    return;
  }
  if (
    ctx.db.get(
      "SELECT r.id FROM review_item r JOIN review_message rm ON rm.review_item_id=r.id WHERE r.status='dismissed' AND rm.message_id IN (SELECT value FROM json_each(?))",
      JSON.stringify([...ids]),
    )
  ) {
    review('evidence belongs to a rejected proposal', confidence);
    return;
  }
  if (
    request.ticket &&
    ctx.db.get(
      "SELECT field FROM workflow_field_source WHERE card_id=? AND field='stage' AND human=1",
      request.ticket.id,
    )
  ) {
    review('explicit human stage override', confidence);
    return;
  }
  const stageLock = request.ticket
    ? ctx.db.get<{ stage_human_set_at: string | null }>(
        'SELECT stage_human_set_at FROM card WHERE id=?',
        request.ticket.id,
      )?.stage_human_set_at
    : null;
  const stageEvidence = Number(result.supports[`support:stage:${values.stage}`]?.choice.replace('message:', ''));
  const stageSource = request.evidence.find((e) => e.id === stageEvidence);
  if (stageLock && (!stageSource || stageSource.sentAt <= stageLock)) {
    review('human stage override is newer than evidence', confidence);
    return;
  }
  if (
    (stage === 'work_in_progress' || stage === 'integrations' || stage === 'completed') &&
    stageSource?.direction !== 'in'
  ) {
    review('outgoing outreach cannot establish customer engagement', confidence);
    return;
  }
  const label: Record<WorkflowAction, string | null> = {
    outreach: 'Send outreach',
    follow_up: 'Follow up on conversation',
    engineering_assessment: 'Follow up engineering assessment',
    run_test: 'Follow up integration tests',
    confirm_live: 'Confirm live usage (message assertion)',
    resolve_blocker: 'Resolve blocker and follow up',
    none: null,
  };
  const fields: WorkflowFields = {
    workstream: values.workstream as WorkflowFields['workstream'],
    nextAction: label[values.action as WorkflowAction],
    followUpAt: request.dates.find((a) => a.id === values.date)?.value ?? null,
    blockedReason: stage === 'blocked' ? (stageSource?.text ?? null) : null,
    buyerId: request.buyerIds.find((a) => a.id === values.buyerId)?.value ?? null,
  };
  const effectiveFields = { ...fields };
  if (request.ticket)
    for (const field of Object.keys(fields) as (keyof WorkflowFields)[]) {
      if (
        ctx.db.get(
          'SELECT field FROM workflow_field_source WHERE card_id=? AND field=? AND human=1',
          request.ticket.id,
          field,
        )
      )
        Object.assign(effectiveFields, { [field]: request.ticket[field] });
    }
  if (
    stage === 'blocked' &&
    (!effectiveFields.blockedReason || (!effectiveFields.nextAction && !effectiveFields.followUpAt))
  ) {
    review('blocked requires explicit reason and next action or follow-up', confidence);
    return;
  }
  if (request.proposal) {
    if (stage === 'blocked') {
      review('new lead needs explicit blocker metadata before a blocked move', confidence);
      return;
    }
    joinWorkflowProposal(
      ctx,
      request,
      d.summary,
      decisionId,
      'Jev workflow assessment with retained evidence; operator acceptance required',
      confidence,
      stage === 'to_be_started'
        ? undefined
        : { id: target.stage_id, messageId: stageEvidence, model: result.configuredModel },
    );
    ctx.db.run("UPDATE decision SET outcome='review' WHERE id=?", decisionId);
    return;
  }
  const opts = { setBy: 'agent' as const, decisionId, reason: 'Jev workflow classification with retained evidence' };
  const cardId =
    request.ticket?.id ??
    createCard(
      ctx,
      {
        laneId: config.lane_id,
        title: d.title as string,
        summary: d.summary as string,
        chatId: input.chat.id,
        messageId: input.message.id,
        fromHistory:
          ctx.db.get<{ origin: string }>('SELECT origin FROM message WHERE id=?', input.message.id)?.origin ===
          'history',
      },
      opts,
    ).id;
  if (request.ticket) {
    attachMessage(ctx, input.message.id, cardId, opts);
    const c = ctx.db.get<{ text_set_by: string; needs_text: number }>(
      'SELECT text_set_by,needs_text FROM card WHERE id=?',
      cardId,
    );
    if (c?.text_set_by !== 'human' && d.summary?.trim())
      updateCard(
        ctx,
        cardId,
        { summary: d.summary, ...(c?.needs_text && d.title?.trim() ? { title: d.title } : {}) },
        opts,
      );
  }
  ctx.db.run('INSERT OR IGNORE INTO workflow_ticket(card_id) VALUES (?)', cardId);
  const columns = {
    workstream: 'workstream',
    nextAction: 'next_action',
    followUpAt: 'follow_up_at',
    blockedReason: 'blocked_reason',
    buyerId: 'buyer_id',
  } as const;
  for (const field of Object.keys(columns) as (keyof WorkflowFields)[]) {
    if (ctx.db.get('SELECT field FROM workflow_field_source WHERE card_id=? AND field=? AND human=1', cardId, field))
      continue;
    // Missing dates/IDs/actions do not erase an earlier still-supported value.
    if (fields[field] === null && field !== 'blockedReason') continue;
    ctx.db.run(`UPDATE workflow_ticket SET ${columns[field]}=? WHERE card_id=?`, fields[field], cardId);
    ctx.db.run(
      'INSERT INTO workflow_field_source(card_id,field,human,source_message_ids,source_chat_ids,source_unknown) VALUES (?,?,0,?,?,?) ON CONFLICT(card_id,field) DO UPDATE SET human=0,source_message_ids=excluded.source_message_ids,source_chat_ids=excluded.source_chat_ids,source_unknown=excluded.source_unknown',
      cardId,
      field,
      JSON.stringify(scope.messageIds),
      JSON.stringify(scope.chatIds),
      Number(unknown),
    );
  }
  if (!request.ticket || stage !== request.ticket.stage) {
    ctx.db.run("UPDATE card SET stage_id=?,last_change_by_kind='agent' WHERE id=?", target.stage_id, cardId);
    ctx.db.run(
      "INSERT INTO workflow_field_source(card_id,field,human,source_message_ids,source_chat_ids,source_unknown) VALUES (?,'stage',0,?,?,?) ON CONFLICT(card_id,field) DO UPDATE SET human=0,source_message_ids=excluded.source_message_ids,source_chat_ids=excluded.source_chat_ids,source_unknown=excluded.source_unknown",
      cardId,
      JSON.stringify(scope.messageIds),
      JSON.stringify(scope.chatIds),
      Number(unknown),
    );
    record(ctx, {
      action: 'card.move',
      subjectKind: 'card',
      subjectId: cardId,
      after: {
        laneId: config.lane_id,
        stageId: target.stage_id,
        criterion: 'Jev retained message assertion; no external transaction verification',
      },
      messageIds: [...ids],
      decisionId,
    });
  }
  record(ctx, {
    action: 'workflow.inferred',
    subjectKind: 'card',
    subjectId: cardId,
    after: {
      ...fields,
      stage,
      confidence,
      provider: 'jev',
      configuredModel: result.configuredModel,
      providerRequestId: result.providerRequestId,
      supportByDimension: Object.fromEntries(
        Object.entries(values).map(([dimension, value]) => [
          dimension,
          result.supports[`support:${dimension}:${value}`]?.choice ?? null,
        ]),
      ),
    },
    messageIds: [...scope.messageIds],
    decisionId,
    reason: 'Jev choices with independently supported evidence; completion is a message assertion',
  });
  ctx.db.run("UPDATE decision SET outcome='applied' WHERE id=?", decisionId);
}
