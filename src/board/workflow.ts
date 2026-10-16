import { z } from 'zod';
import type { Ctx, Id, WorkflowBoard, WorkflowFields, WorkflowStage, WorkflowTicket } from '../contracts/index.ts';
import { AppError, IdSchema } from '../contracts/index.ts';
import { record } from '../log/index.ts';
import { createCard, moveCard } from './cards.ts';
import { archiveCard, unarchiveCard } from './corrections.ts';
import { lane, summary, validate } from './helpers.ts';
import { createLane } from './lanes.ts';
import {
  createWorkflowSchema,
  moveWorkflowSchema,
  updateWorkflowSchema,
  workflowAccess,
  workflowStageDefinitions,
} from './workflow-schema.ts';

export function getWorkflowBoard(ctx: Ctx): WorkflowBoard {
  workflowAccess(ctx);
  const config = ctx.db.get<{ lane_id: Id; automatic: number; confidence_threshold: number; time_zone: string }>(
    'SELECT * FROM workflow_config WHERE id=1',
  );
  const stages = workflowStageDefinitions.map((s) => ({
    key: s.key,
    name: s.name,
    id: ctx.db.get<{ stage_id: Id }>('SELECT stage_id FROM workflow_stage WHERE key=?', s.key)?.stage_id ?? null,
  }));
  return {
    lane: config ? lane(ctx, config.lane_id) : null,
    tickets: config
      ? ctx.db
          .all<{ id: Id }>('SELECT id FROM card WHERE lane_id=? ORDER BY id', config.lane_id)
          .map((r) => getWorkflowTicket(ctx, r.id))
      : [],
    stages: [...stages, { key: 'archive', id: null, name: 'Archive' }],
    automatic: Boolean(config?.automatic),
    confidenceThreshold: config?.confidence_threshold ?? 0.85,
    timeZone: config?.time_zone ?? 'Asia/Kolkata',
  };
}
export function getWorkflowTicket(ctx: Ctx, cardId: Id): WorkflowTicket {
  workflowAccess(ctx);
  validate(IdSchema, cardId);
  const c = summary(ctx, cardId);
  if (!ctx.db.get('SELECT id FROM workflow_config WHERE lane_id=?', c.laneId))
    throw new AppError('not_found', 'Not a configured workflow ticket');
  const r = ctx.db.get<{ summary: string; workflow_version: number }>(
    'SELECT summary,workflow_version FROM card WHERE id=?',
    cardId,
  );
  const fields = ctx.db.get<WorkflowFields>(
    'SELECT workstream,next_action AS nextAction,follow_up_at AS followUpAt,blocked_reason AS blockedReason,buyer_id AS buyerId FROM workflow_ticket WHERE card_id=?',
    cardId,
  );
  const stage = ctx.db.get<{ key: WorkflowStage }>('SELECT key FROM workflow_stage WHERE stage_id=?', c.stageId);
  if (!stage || !r) throw new AppError('conflict', 'Workflow stage configuration changed');
  return {
    ...(fields ?? { workstream: 'others', nextAction: null, followUpAt: null, blockedReason: null, buyerId: null }),
    card: c,
    summary: r.summary,
    workflowStage: c.archived ? 'archive' : stage.key,
    version: r.workflow_version,
  };
}
export function configureWorkflow(ctx: Ctx): WorkflowBoard {
  workflowAccess(ctx, true);
  if (ctx.actor.kind !== 'teammate') throw new AppError('forbidden', 'Teammate setup required');
  return ctx.db.tx(() => {
    if (!ctx.db.get('SELECT id FROM workflow_config WHERE id=1')) {
      const l = createLane(ctx, {
        name: 'Enterprise & partnerships',
        sop: 'One partnerships and sales pipeline. Workstreams: Buyer, Provider, Integration, Others (including internal tasks). No automatic archive from silence. Completion requires evidence, not buyer ID alone.',
        stages: workflowStageDefinitions.map((s) => ({ name: s.name, criteria: s.criteria })),
      });
      ctx.db.run('INSERT INTO workflow_config(id,lane_id) VALUES (1,?)', l.id);
      for (const [n, s] of workflowStageDefinitions.entries())
        ctx.db.run('INSERT INTO workflow_stage(key,stage_id) VALUES (?,?)', s.key, l.stages[n]?.id ?? null);
      record(ctx, {
        action: 'workflow.configure',
        subjectKind: 'lane',
        subjectId: l.id,
        after: { automatic: true, confidenceThreshold: 0.85, timeZone: 'Asia/Kolkata' },
      });
    }
    return getWorkflowBoard(ctx);
  });
}
export function createWorkflowTicket(
  ctx: Ctx,
  input: {
    title: string;
    summary?: string;
    workstream?: WorkflowFields['workstream'];
    nextAction?: string | null;
    followUpAt?: string | null;
    chatId?: Id;
    companyId?: Id;
  },
): WorkflowTicket {
  workflowAccess(ctx, true);
  const i = validate(createWorkflowSchema, input);
  return ctx.db.tx(() => {
    const config = ctx.db.get<{ lane_id: Id }>('SELECT lane_id FROM workflow_config WHERE id=1');
    if (!config) throw new AppError('conflict', 'Configure workflow first');
    const c = createCard(ctx, {
      laneId: config.lane_id,
      title: i.title,
      summary: i.summary,
      chatId: i.chatId,
      companyId: i.companyId,
    });
    ctx.db.run(
      'INSERT INTO workflow_ticket(card_id,workstream,next_action,follow_up_at) VALUES (?,?,?,?)',
      c.id,
      i.workstream ?? 'others',
      i.nextAction ?? null,
      i.followUpAt ?? null,
    );
    for (const field of ['workstream', 'nextAction', 'followUpAt'] as const)
      if (i[field] !== undefined)
        ctx.db.run('INSERT INTO workflow_field_source(card_id,field,human) VALUES (?,?,1)', c.id, field);
    record(ctx, {
      action: 'workflow.create',
      subjectKind: 'card',
      subjectId: c.id,
      after: {
        workstream: i.workstream ?? 'others',
        nextAction: i.nextAction ?? null,
        followUpAt: i.followUpAt ?? null,
      },
    });
    return getWorkflowTicket(ctx, c.id);
  });
}
export function updateWorkflowTicket(
  ctx: Ctx,
  cardId: Id,
  input: {
    version: number;
    workstream?: WorkflowFields['workstream'];
    nextAction?: string | null;
    followUpAt?: string | null;
    blockedReason?: string | null;
    buyerId?: string | null;
  },
): WorkflowTicket {
  workflowAccess(ctx, true);
  const i = validate(updateWorkflowSchema, input);
  return ctx.db.tx(() => {
    const before = getWorkflowTicket(ctx, cardId);
    if (before.version !== i.version) throw new AppError('conflict', 'Stale ticket version');
    const after = { ...before, ...i };
    if (before.workflowStage === 'blocked' && (!after.blockedReason || (!after.nextAction && !after.followUpAt)))
      throw new AppError('invalid', 'Blocked requires a reason and next action or follow-up');
    ctx.db.run('INSERT OR IGNORE INTO workflow_ticket(card_id) VALUES (?)', cardId);
    ctx.db.run(
      'UPDATE workflow_ticket SET workstream=?,next_action=?,follow_up_at=?,blocked_reason=?,buyer_id=? WHERE card_id=?',
      after.workstream,
      after.nextAction,
      after.followUpAt,
      after.blockedReason,
      after.buyerId,
      cardId,
    );
    for (const field of ['workstream', 'nextAction', 'followUpAt', 'blockedReason', 'buyerId'] as const)
      if (i[field] !== undefined)
        ctx.db.run(
          "INSERT INTO workflow_field_source(card_id,field,human) VALUES (?,?,1) ON CONFLICT(card_id,field) DO UPDATE SET human=1,source_message_ids='[]',source_chat_ids='[]'",
          cardId,
          field,
        );
    ctx.db.run('UPDATE card SET last_change_by_kind=? WHERE id=?', ctx.actor.kind, cardId);
    record(ctx, {
      action: 'workflow.update',
      subjectKind: 'card',
      subjectId: cardId,
      before: {
        workstream: before.workstream,
        nextAction: before.nextAction,
        followUpAt: before.followUpAt,
        blockedReason: before.blockedReason,
        buyerId: before.buyerId,
      },
      after: {
        workstream: after.workstream,
        nextAction: after.nextAction,
        followUpAt: after.followUpAt,
        blockedReason: after.blockedReason,
        buyerId: after.buyerId,
      },
    });
    return getWorkflowTicket(ctx, cardId);
  });
}
export function moveWorkflowTicket(
  ctx: Ctx,
  cardId: Id,
  input: { version: number; to: WorkflowStage; reason: string; evidenceMessageIds?: Id[] },
): WorkflowTicket {
  workflowAccess(ctx, true);
  const i = validate(moveWorkflowSchema, input);
  return ctx.db.tx(() => {
    const before = getWorkflowTicket(ctx, cardId);
    if (before.version !== i.version) throw new AppError('conflict', 'Stale ticket version');
    for (const id of i.evidenceMessageIds ?? [])
      if (
        !ctx.db.get(
          'SELECT m.id FROM message m JOIN card_chat cc ON cc.chat_id=m.chat_id JOIN chat ch ON ch.id=m.chat_id WHERE m.id=? AND cc.card_id=? AND m.deleted_at IS NULL AND ch.withdrawn_at IS NULL',
          id,
          cardId,
        )
      )
        throw new AppError('invalid', 'Evidence is not retained ticket context');
    if (i.to === 'blocked' && (!before.blockedReason || (!before.nextAction && !before.followUpAt)))
      throw new AppError('invalid', 'Blocked requires a reason and next action or follow-up');
    if (i.to === 'archive') archiveCard(ctx, cardId);
    else {
      const s = ctx.db.get<{ stage_id: Id }>('SELECT stage_id FROM workflow_stage WHERE key=?', i.to);
      if (!s) throw new AppError('invalid', 'Workflow stage unavailable');
      if (before.card.archived) unarchiveCard(ctx, cardId);
      moveCard(
        ctx,
        cardId,
        { stageId: s.stage_id, criterion: i.reason, evidenceMessageIds: i.evidenceMessageIds },
        { reason: i.reason },
      );
    }
    record(ctx, {
      action: 'workflow.move',
      subjectKind: 'card',
      subjectId: cardId,
      before: { stage: before.workflowStage },
      after: { stage: i.to },
      reason: i.reason,
      messageIds: i.evidenceMessageIds,
    });
    return getWorkflowTicket(ctx, cardId);
  });
}
export function getDailyPriorities(
  ctx: Ctx,
  input?: { at?: string; limit?: number },
): import('../contracts/index.ts').WorkflowPriorities {
  const i = validate(
    z.strictObject({
      at: z.iso.datetime({ offset: true }).optional(),
      limit: z.number().int().positive().max(500).optional(),
    }),
    input ?? {},
  );
  const board = getWorkflowBoard(ctx),
    asOf = i.at ?? ctx.now().toISOString();
  const day = (t: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: board.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(t));
  const today = day(asOf),
    active = board.tickets.filter((t) => !['archive', 'completed'].includes(t.workflowStage));
  const timed = active
    .filter((t) => t.followUpAt)
    .sort((a, b) => (a.followUpAt ?? '').localeCompare(b.followUpAt ?? '') || a.card.id - b.card.id);
  const cap = (t: WorkflowTicket[]) => t.slice(0, i.limit ?? 50);
  return {
    asOf,
    overdue: cap(timed.filter((t) => day(t.followUpAt as string) < today)),
    dueToday: cap(timed.filter((t) => day(t.followUpAt as string) === today)),
    blocked: cap(active.filter((t) => t.workflowStage === 'blocked')),
    upcoming: cap(timed.filter((t) => day(t.followUpAt as string) > today)),
  };
}
