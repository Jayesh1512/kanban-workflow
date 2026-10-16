import { attachMessage, createCard, dismissCardOffer, moveCard, updateCard } from '../board/index.ts';
import type { Ctx, Id, ReviewChange, ReviewItemView, ReviewProposal } from '../contracts/index.ts';
import { AppError, IdSchema, ReviewChangeSchema, ReviewProposalSchema } from '../contracts/index.ts';
import {
  addCompanyAlias,
  ensureCompany,
  markNotSame,
  normalizeCompanyName,
  recordReference,
  setContactCompany,
  setContactRole,
} from '../graph/index.ts';
import { getMessages } from '../ingest/index.ts';
import { record } from '../log/index.ts';
import { validateSettlement } from './movement/audit.ts';
import { validateReviewState } from './review-state.ts';
import { eligibleChat } from './selection.ts';

interface ReviewRow {
  id: Id;
  kind: ReviewProposal['kind'];
  why: ReviewItemView['why'];
  proposal: string;
  confidence: number;
  reason: string;
  status: string;
  chat_id: Id | null;
  created_at: string;
  updated_at: string;
}
function row(ctx: Ctx, id: Id): ReviewRow {
  if (!IdSchema.safeParse(id).success) throw new AppError('invalid', 'Invalid review id');
  const r = ctx.db.get<ReviewRow>('SELECT * FROM review_item WHERE id=?', id);
  if (!r) throw new AppError('not_found', 'Review not found');
  return r;
}
function human(ctx: Ctx): void {
  if (
    ctx.actor.kind !== 'teammate' ||
    !ctx.db.get('SELECT id FROM teammate WHERE id=? AND removed_at IS NULL', ctx.actor.id)
  )
    throw new AppError('forbidden', 'Active teammate required');
}
function evidence(ctx: Ctx, id: Id) {
  return ctx.db.all<{
    id: Id;
    chat_id: Id;
    origin: string;
    version: number;
    deleted_at: string | null;
    withdrawn_at: string | null;
    recordedVersion: number | null;
  }>(
    `SELECT m.id,m.chat_id,m.origin,m.version,m.deleted_at,ch.withdrawn_at,d.message_version AS recordedVersion FROM review_message rm JOIN message m ON m.id=rm.message_id JOIN chat ch ON ch.id=m.chat_id LEFT JOIN decision d ON d.id=rm.decision_id AND d.message_id=m.id WHERE rm.review_item_id=? ORDER BY m.sent_at,m.id`,
    id,
  );
}
function liveEvidence(ctx: Ctx, id: Id) {
  const items = evidence(ctx, id);
  if (
    !ctx.canReadText ||
    !items.length ||
    items.some(
      (m) =>
        m.deleted_at !== null ||
        m.withdrawn_at !== null ||
        !eligibleChat(ctx, m.chat_id) ||
        (m.recordedVersion !== null && m.recordedVersion !== m.version),
    )
  )
    throw new AppError('conflict', 'Review evidence is unavailable');
  return items;
}
function changes(p: ReviewProposal): ReviewChange['to'][] {
  switch (p.kind) {
    case 'new_card':
    case 'attach':
    case 'is_work':
    case 'model_failed':
      return ['new_card', 'card'];
    case 'move':
      return ['stage'];
    case 'contact_company':
      return ['company'];
    case 'contact_role':
      return ['role'];
    case 'name_company':
      return [];
  }
}
export function getReview(ctx: Ctx, id: Id): ReviewItemView {
  const r = row(ctx, id),
    proposal = ReviewProposalSchema.parse(JSON.parse(r.proposal));
  const items = evidence(ctx, id);
  let canAccept = r.status === 'open' && proposal.kind !== 'model_failed';
  if (canAccept) {
    try {
      liveEvidence(ctx, id);
      validateReviewState(ctx, id, proposal);
      validateSettlement(ctx, id, proposal);
    } catch {
      canAccept = false;
    }
  }
  const descriptions: Record<ReviewProposal['kind'], string> = {
    new_card: 'Create a card and attach these messages.',
    attach: 'Attach these messages to the selected card.',
    move: 'Move the card to the proposed stage.',
    is_work: 'Settle these messages as no card.',
    contact_company: 'Set the contact’s company.',
    contact_role: 'Set the contact’s role.',
    name_company: 'Remember this name as an alias and apply its held uses.',
    model_failed: 'Choose a card or dismiss these messages.',
  };
  const chat =
    r.chat_id === null
      ? null
      : (ctx.db.get<{ id: Id; title: string }>('SELECT id,title FROM chat WHERE id=?', r.chat_id) ?? null);
  return {
    id: r.id,
    kind: r.kind,
    why: r.why,
    confidence: r.confidence,
    reason: r.reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    chat,
    proposal,
    describe: descriptions[proposal.kind],
    messages: getMessages(ctx, { ids: items.map((m) => m.id) }).reverse(),
    canAccept,
    allowedChanges: changes(proposal),
  };
}
export function listReview(ctx: Ctx, q?: { limit?: number }): ReviewItemView[] {
  const limit = q?.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new AppError('invalid', 'Invalid review limit');
  return ctx.db
    .all<{ id: Id }>("SELECT id FROM review_item WHERE status='open' ORDER BY created_at,id LIMIT ?", limit)
    .map((r) => getReview(ctx, r.id));
}
function attachAll(ctx: Ctx, ids: Id[], cardId: Id): void {
  for (const id of ids) attachMessage(ctx, id, cardId, { setBy: 'human' });
}
function reference(ctx: Ctx, messageId: Id, companyId: Id): void {
  const card = ctx.db.get<{ id: Id; company_id: Id | null }>(
    'SELECT c.id,c.company_id FROM card_message cm JOIN card c ON c.id=cm.card_id WHERE cm.message_id=?',
    messageId,
  );
  const company = ctx.db.all<{ id: Id }>(
    'SELECT DISTINCT cc.company_id AS id FROM message m JOIN identity i ON i.id=m.sender_identity_id JOIN contact_company cc ON cc.contact_id=i.contact_id WHERE m.id=? AND cc.removed=0',
    messageId,
  );
  recordReference(
    ctx,
    {
      messageId,
      toCompanyId: companyId,
      cardId: card?.id ?? null,
      fromCompanyId: card?.company_id ?? (company.length === 1 ? (company[0]?.id ?? null) : null),
    },
    { setBy: ctx.actor.kind === 'agent' ? 'agent' : 'human' },
  );
}
function applyProposal(ctx: Ctx, id: Id, p: ReviewProposal): Id | null {
  const messages = liveEvidence(ctx, id),
    ids = messages.map((m) => m.id),
    first = messages[0];
  if (!first) throw new AppError('conflict', 'Review evidence is unavailable');
  switch (p.kind) {
    case 'new_card': {
      const c = createCard(
        ctx,
        {
          laneId: p.laneId,
          title: p.title,
          summary: p.summary,
          companyId: p.companyId,
          chatId: first.chat_id,
          messageId: first.id,
          fromHistory: first.origin === 'history',
        },
        { setBy: 'human' },
      );
      attachAll(ctx, ids.slice(1), c.id);
      if (p.move)
        moveCard(
          ctx,
          c.id,
          { stageId: p.move.toStageId, criterion: p.move.criterion, evidenceMessageIds: ids },
          { setBy: 'human' },
        );
      return c.id;
    }
    case 'attach': {
      const text = ctx.db.get<{ text_set_by: string }>('SELECT text_set_by FROM card WHERE id=?', p.cardId);
      attachAll(ctx, ids, p.cardId);
      if (text?.text_set_by !== 'human') {
        const producer = ctx.db.get<{ raw: string }>(
          'SELECT d.raw FROM decision d JOIN review_message rm ON rm.decision_id=d.id WHERE rm.review_item_id=? ORDER BY d.id DESC LIMIT 1',
          id,
        );
        const d = producer ? JSON.parse(producer.raw) : null;
        const needsText = ctx.db.get<{ needs_text: number }>(
          'SELECT needs_text FROM card WHERE id=?',
          p.cardId,
        )?.needs_text;
        const fields: { title?: string; summary?: string } = {};
        if (needsText && typeof d?.title === 'string' && d.title.trim()) fields.title = d.title;
        if (p.summary !== null) fields.summary = p.summary;
        if (Object.keys(fields).length) updateCard(ctx, p.cardId, fields, { setBy: 'human' });
      }
      return p.cardId;
    }
    case 'move':
      moveCard(
        ctx,
        p.cardId,
        { stageId: p.toStageId, criterion: p.criterion, evidenceMessageIds: ids },
        { setBy: 'human' },
      );
      return null;
    case 'is_work':
      for (const m of ids) {
        const movementOnly =
          p.kind === 'model_failed' &&
          ctx.db.get(
            'SELECT md.decision_id FROM movement_decision md JOIN review_message rm ON rm.decision_id=md.decision_id WHERE rm.review_item_id=? AND rm.message_id=?',
            id,
            m,
          );
        if (!movementOnly) attachMessage(ctx, m, null, { setBy: 'human' });
      }
      return null;
    case 'contact_company':
      setContactCompany(ctx, p.contactId, { company: p.company, evidenceMessageIds: ids }, { setBy: 'human' });
      return null;
    case 'contact_role':
      setContactRole(
        ctx,
        p.contactId,
        { category: p.category, dealsAbout: p.dealsAbout, evidenceMessageIds: ids },
        { setBy: 'human' },
      );
      return null;
    case 'name_company': {
      addCompanyAlias(ctx, p.companyId, p.name);
      for (const use of p.held) {
        if (use.use === 'contact_company')
          setContactCompany(
            ctx,
            use.contactId,
            { company: { id: p.companyId }, evidenceMessageIds: use.evidenceMessageIds },
            { setBy: 'human' },
          );
        else {
          reference(ctx, use.messageId, p.companyId);
          ctx.db.run(
            'DELETE FROM pending_mention WHERE message_id=? AND name_norm=?',
            use.messageId,
            normalizeCompanyName(p.name),
          );
        }
      }
      return null;
    }
    case 'model_failed':
      throw new AppError('invalid', 'Failed model review requires change or dismissal');
  }
}
function settle(
  ctx: Ctx,
  r: ReviewRow,
  status: 'accepted' | 'changed' | 'dismissed',
  cardId: Id | null,
  extra: unknown,
): void {
  const at = ctx.now().toISOString();
  ctx.db.run(
    'UPDATE review_item SET status=?,result_card_id=?,resolved_by=?,resolved_at=?,updated_at=? WHERE id=?',
    status,
    cardId,
    ctx.actor.kind === 'teammate' ? ctx.actor.id : null,
    at,
    at,
    r.id,
  );
  record(ctx, {
    action: status === 'accepted' ? 'review.accept' : status === 'changed' ? 'review.change' : 'review.dismiss',
    subjectKind: 'review',
    subjectId: r.id,
    before: { proposal: ReviewProposalSchema.parse(JSON.parse(r.proposal)) },
    after: extra,
    reason: r.reason,
    messageIds: evidence(ctx, r.id).map((m) => m.id),
  });
}
export function acceptReview(ctx: Ctx, id: Id): void {
  human(ctx);
  ctx.db.tx(() => {
    const r = row(ctx, id);
    if (r.status !== 'open') throw new AppError('conflict', 'Review already settled');
    const p = ReviewProposalSchema.parse(JSON.parse(r.proposal));
    validateReviewState(ctx, id, p);
    validateSettlement(ctx, id, p);
    const cardId = applyProposal(ctx, id, p);
    settle(ctx, r, 'accepted', cardId, { cardId });
  });
}
export function changeReview(ctx: Ctx, id: Id, change: ReviewChange): void {
  human(ctx);
  const parsed = ReviewChangeSchema.safeParse(change);
  if (!parsed.success) throw new AppError('invalid', 'Invalid review change');
  ctx.db.tx(() => {
    const r = row(ctx, id);
    if (r.status !== 'open') throw new AppError('conflict', 'Review already settled');
    const old = ReviewProposalSchema.parse(JSON.parse(r.proposal));
    if (!changes(old).includes(change.to)) throw new AppError('invalid', 'Change is not allowed for review');
    const ids = liveEvidence(ctx, id).map((m) => m.id);
    let cardId: Id | null = null;
    switch (change.to) {
      case 'new_card': {
        const p: ReviewProposal = {
          kind: 'new_card',
          laneId: change.laneId,
          title: change.title,
          summary: change.summary,
          companyId: null,
          move: null,
        };
        cardId = applyProposal(ctx, id, p);
        if (change.stageId !== null && cardId !== null)
          moveCard(ctx, cardId, { stageId: change.stageId, evidenceMessageIds: ids }, { setBy: 'human' });
        break;
      }
      case 'card':
        attachAll(ctx, ids, change.cardId);
        cardId = change.cardId;
        break;
      case 'stage':
        if (old.kind !== 'move') throw new AppError('invalid', 'Move review required');
        moveCard(ctx, old.cardId, { stageId: change.stageId, evidenceMessageIds: ids }, { setBy: 'human' });
        break;
      case 'company':
        if (old.kind !== 'contact_company') throw new AppError('invalid', 'Company review required');
        setContactCompany(
          ctx,
          old.contactId,
          { company: { name: change.company }, evidenceMessageIds: ids },
          { setBy: 'human' },
        );
        break;
      case 'role':
        if (old.kind !== 'contact_role') throw new AppError('invalid', 'Role review required');
        setContactRole(
          ctx,
          old.contactId,
          { category: change.category, dealsAbout: change.dealsAbout, evidenceMessageIds: ids },
          { setBy: 'human' },
        );
        break;
    }
    settle(ctx, r, 'changed', cardId, { change, cardId });
  });
}
export function dismissReview(ctx: Ctx, id: Id): void {
  human(ctx);
  ctx.db.tx(() => {
    const r = row(ctx, id);
    if (r.status !== 'open') throw new AppError('conflict', 'Review already settled');
    const p = ReviewProposalSchema.parse(JSON.parse(r.proposal)),
      ids = liveEvidence(ctx, id).map((m) => m.id);
    if (['new_card', 'attach', 'is_work', 'model_failed'].includes(p.kind))
      for (const m of ids) {
        const movementOnly =
          p.kind === 'model_failed' &&
          ctx.db.get(
            'SELECT md.decision_id FROM movement_decision md JOIN review_message rm ON rm.decision_id=md.decision_id WHERE rm.review_item_id=? AND rm.message_id=?',
            id,
            m,
          );
        if (!movementOnly) attachMessage(ctx, m, null, { setBy: 'human' });
      }
    if (p.kind === 'attach' && r.why === 'cross_chat' && r.chat_id !== null) dismissCardOffer(ctx, p.cardId, r.chat_id);
    if (p.kind === 'name_company' && r.why === 'similar_name') {
      markNotSame(ctx, p.name, p.companyId);
      for (const use of p.held) {
        if (use.use === 'contact_company') {
          const companyId = ensureCompany(ctx, p.name);
          setContactCompany(
            ctx,
            use.contactId,
            { company: { id: companyId }, evidenceMessageIds: use.evidenceMessageIds },
            { setBy: 'human' },
          );
        } else
          ctx.db.run(
            'INSERT INTO pending_mention(message_id,name,name_norm,confidence,created_at) VALUES (?,?,?,?,?) ON CONFLICT(message_id,name_norm) DO NOTHING',
            use.messageId,
            p.name,
            normalizeCompanyName(p.name),
            r.confidence,
            ctx.now().toISOString(),
          );
      }
    }
    settle(ctx, r, 'dismissed', null, {});
  });
}
export function recheckPendingMentions(ctx: Ctx): number {
  void ctx;
  throw new AppError('invalid', 'not built: recheckPendingMentions');
}
