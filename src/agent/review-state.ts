import { getSetting } from '../auth/index.ts';
import type { AgentWorkScope, Ctx, Id, ReviewProposal } from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';
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
    }));
  const raw = ctx.db.get<{ raw: string }>('SELECT raw FROM decision WHERE id=?', decisionId)?.raw;
  ctx.db.run(
    'UPDATE decision SET raw=? WHERE id=?',
    JSON.stringify({ ...JSON.parse(raw ?? '{}'), __reviewSettlements: settlements }),
    decisionId,
  );
}
export function validateReviewState(ctx: Ctx, id: Id, p: ReviewProposal): void {
  if (p.kind === 'model_failed') throw new AppError('conflict', 'Review has no proposed action');
  const expected = digest(p);
  for (const row of ctx.db.all<{ raw: string }>(
    'SELECT DISTINCT d.id,d.raw FROM decision d JOIN review_message rm ON rm.decision_id=d.id WHERE rm.review_item_id=? ORDER BY d.id DESC',
    id,
  )) {
    const raw: unknown = JSON.parse(row.raw);
    if (!raw || typeof raw !== 'object' || !('__reviewSettlements' in raw) || !Array.isArray(raw.__reviewSettlements))
      continue;
    const match = raw.__reviewSettlements.find(
      (s: unknown) =>
        s && typeof s === 'object' && 'id' in s && s.id === id && 'proposal' in s && s.proposal === expected,
    );
    if (!match || !Array.isArray(match.sources) || !sourcesCurrent(ctx, match.sources) || match.state !== state(ctx, p))
      throw new AppError('conflict', 'Review state changed');
    return;
  }
  throw new AppError('conflict', 'Review provenance is unavailable');
}
