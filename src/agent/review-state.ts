import { z } from 'zod';
import { getSetting } from '../auth/index.ts';
import type { AgentWorkScope, Ctx, Id, ReviewProposal } from '../contracts/index.ts';
import { AppError, IdSchema } from '../contracts/index.ts';
import { normalizeCompanyName } from '../graph/index.ts';
import { digest } from './json.ts';
import { eligibleChat } from './selection.ts';

export interface ReviewSource {
  id: Id;
  chatId: Id;
  hash: string;
}
export function captureReviewSources(ctx: Ctx, scope: AgentWorkScope): ReviewSource[] | null {
  if (scope.chatIds.some((id) => !eligibleChat(ctx, id))) return null;
  const sources: ReviewSource[] = [];
  for (const id of scope.messageIds) {
    const row = ctx.db.get<{ chat_id: Id; deleted_at: string | null }>('SELECT * FROM message WHERE id=?', id);
    if (!row || row.deleted_at !== null || !eligibleChat(ctx, row.chat_id)) return null;
    sources.push({ id, chatId: row.chat_id, hash: digest({ ...row, processed_version: 0 }) });
  }
  return sources;
}
function sourcesCurrent(ctx: Ctx, sources: ReviewSource[]): boolean {
  return sources.every((s) => {
    const row = ctx.db.get<{ chat_id: Id; deleted_at: string | null }>('SELECT * FROM message WHERE id=?', s.id);
    // Processing is an expected own write. Content, version and source identity stay bound.
    return (
      !!row &&
      row.chat_id === s.chatId &&
      row.deleted_at === null &&
      eligibleChat(ctx, s.chatId) &&
      digest({ ...row, processed_version: 0 }) === s.hash
    );
  });
}

const assignmentSchema = z.strictObject({
  messageId: IdSchema,
  link: z.strictObject({ card_id: IdSchema.nullable(), set_by: z.enum(['agent', 'human']) }).nullable(),
  humanLog: z.strictObject({ id: IdSchema.nullable() }),
});
const settlementSchema = z.object({
  id: IdSchema,
  proposal: z.string(),
  state: z.string(),
  sources: z.array(z.strictObject({ id: IdSchema, chatId: IdSchema, hash: z.string() })),
  assignments: z.array(assignmentSchema.nullable()).optional(),
});
function storedSettlements(raw: string): z.infer<typeof settlementSchema>[] {
  const parsed = z.object({ __reviewSettlements: z.array(settlementSchema) }).safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data.__reviewSettlements : [];
}

// Bind both the current link and the latest actual human assignment write. The
// latter catches a human moving away and back, even at the same clock instant.
function assignment(ctx: Ctx, messageId: Id) {
  return {
    messageId,
    link: ctx.db.get('SELECT card_id,set_by FROM card_message WHERE message_id=?', messageId) ?? null,
    humanLog: ctx.db.get(
      "SELECT max(id) AS id FROM action_log WHERE actor_kind IN ('teammate','credential') AND action IN ('message.attach','message.detach') AND EXISTS (SELECT 1 FROM json_each(action_log.message_ids) WHERE value=?)",
      messageId,
    ),
  };
}
function assignments(ctx: Ctx, reviewId: Id, decisionId?: Id) {
  return ctx.db
    .all<{ message_id: Id; decision_id: Id | null; raw: string | null }>(
      'SELECT rm.message_id,rm.decision_id,d.raw FROM review_message rm LEFT JOIN decision d ON d.id=rm.decision_id WHERE rm.review_item_id=? ORDER BY rm.message_id',
      reviewId,
    )
    .map((r) => {
      if (decisionId !== undefined && r.decision_id !== decisionId) {
        const settled = storedSettlements(r.raw ?? '{}').find((s) => s.id === reviewId);
        // A join never reauthorizes a prior message whose question went stale.
        return settled?.assignments?.find((a) => a?.messageId === r.message_id) ?? null;
      }
      return assignment(ctx, r.message_id);
    });
}
export function validateCompanyProposal(p: ReviewProposal): void {
  if (
    (p.kind === 'contact_company' && 'name' in p.company && !normalizeCompanyName(p.company.name)) ||
    (p.kind === 'name_company' && !normalizeCompanyName(p.name))
  )
    throw new AppError('conflict', 'Review company name is invalid');
}

// Content-free expected post-write state, attached to its actual producing decision.
// It does not replace the immutable provider request or its evidence correlation.
function state(ctx: Ctx, p: ReviewProposal): string {
  const lanes = ctx.db.all('SELECT * FROM lane ORDER BY id');
  const stages = ctx.db.all('SELECT * FROM stage ORDER BY id');
  const cardId = p.kind === 'move' || p.kind === 'attach' ? p.cardId : null;
  const contactId = p.kind === 'contact_role' || p.kind === 'contact_company' ? p.contactId : null;
  return digest({
    lanes,
    stages,
    roles: p.kind === 'contact_role' ? getSetting(ctx.db, 'role_categories') : null,
    card:
      cardId === null
        ? null
        : ctx.db.get(
            p.kind === 'move'
              ? 'SELECT id,lane_id,stage_id,stage_human_set_at,archived_at FROM card WHERE id=?'
              : 'SELECT id,lane_id,stage_id,title,summary,text_set_by,company_id,company_set_by,needs_text,archived_at FROM card WHERE id=?',
            cardId,
          ),
    cardLog:
      cardId === null
        ? null
        : ctx.db.get(
            "SELECT max(id) AS id FROM action_log WHERE subject_kind='card' AND subject_id=? AND (?<>'move' OR action='card.move')",
            cardId,
            p.kind,
          ),
    contact:
      contactId === null || p.kind !== 'contact_role'
        ? null
        : ctx.db.get('SELECT role_category,deals_about,role_set_by FROM contact WHERE id=?', contactId),
    companies:
      contactId === null || p.kind !== 'contact_company'
        ? null
        : ctx.db.all('SELECT * FROM contact_company WHERE contact_id=? ORDER BY company_id', contactId),
    contactLog:
      contactId === null
        ? null
        : ctx.db.get(
            "SELECT max(id) AS id FROM action_log WHERE subject_kind='contact' AND subject_id=? AND ((?='contact_role' AND action='contact.set_role') OR (?='contact_company' AND action IN ('contact.set_company','contact.remove_company')))",
            contactId,
            p.kind,
            p.kind,
          ),
  });
}
export function bindReviewState(ctx: Ctx, decisionId: Id, sources: ReviewSource[]): void {
  const settlements = ctx.db
    .all<{ id: Id; proposal: string }>(
      "SELECT DISTINCT r.id,r.proposal FROM review_item r JOIN review_message rm ON rm.review_item_id=r.id WHERE rm.decision_id=? AND r.status='open'",
      decisionId,
    )
    .map((r) => ({
      id: r.id,
      proposal: digest(JSON.parse(r.proposal)),
      state: state(ctx, JSON.parse(r.proposal)),
      sources,
      assignments: assignments(ctx, r.id, decisionId),
    }));
  const raw = ctx.db.get<{ raw: string }>('SELECT raw FROM decision WHERE id=?', decisionId)?.raw;
  ctx.db.run(
    'UPDATE decision SET raw=? WHERE id=?',
    JSON.stringify({ ...JSON.parse(raw ?? '{}'), __reviewSettlements: settlements }),
    decisionId,
  );
}
export function validateReviewState(ctx: Ctx, id: Id, p: ReviewProposal, assignmentsOnly = false): void {
  validateCompanyProposal(p);
  if (!assignmentsOnly && p.kind === 'model_failed') throw new AppError('conflict', 'Review has no proposed action');
  const expected = digest(p);
  for (const row of ctx.db.all<{ raw: string }>(
    'SELECT DISTINCT d.id,d.raw FROM decision d JOIN review_message rm ON rm.decision_id=d.id WHERE rm.review_item_id=? ORDER BY d.id DESC',
    id,
  )) {
    const match = storedSettlements(row.raw).find((s) => s.id === id && s.proposal === expected);
    if (
      !match ||
      !Array.isArray(match.sources) ||
      (!assignmentsOnly && !sourcesCurrent(ctx, match.sources)) ||
      ((assignmentsOnly || ['new_card', 'attach', 'is_work'].includes(p.kind)) &&
        (!Array.isArray(match.assignments) ||
          match.assignments.some((a: unknown) => a === null) ||
          digest(match.assignments) !== digest(assignments(ctx, id)))) ||
      (!assignmentsOnly && match.state !== state(ctx, p))
    )
      throw new AppError('conflict', 'Review state changed');
    return;
  }
  throw new AppError('conflict', 'Review provenance is unavailable');
}
