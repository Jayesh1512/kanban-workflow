import { getSetting } from '../auth/index.ts';
import type { Db, GuardFacts, Id, ModelDecision, Outcome, SetBy } from '../contracts/index.ts';
import { AppError, ModelDecisionSchema } from '../contracts/index.ts';
import { normalizeCompanyName, resolveCompany } from '../graph/index.ts';
import { spineInput } from './spine-input.ts';

export { applyAction } from './apply.ts';
export function readGuardFacts(db: Db, messageId: Id, decision: ModelDecision): GuardFacts {
  const ctx = {
    db,
    actor: { kind: 'agent' as const },
    canReadText: true,
    now: () => {
      throw new AppError('invalid', 'Guard has no clock');
    },
  };
  const m = db.get<{ id: Id; chatId: Id; sentAt: string; origin: string; text: string }>(
    'SELECT id,chat_id AS chatId,sent_at AS sentAt,origin,text FROM message WHERE id=? AND deleted_at IS NULL',
    messageId,
  );
  if (!m) throw new AppError('not_found', 'Message not found');
  const input = spineInput(ctx, messageId);
  const names = [
    ...new Set(
      [
        decision.cardCompanyName,
        ...decision.contacts.map((c) => c.companyName),
        ...decision.mentions.map((c) => c.name),
      ].filter((n): n is string => n !== null),
    ),
  ];
  return {
    threshold: getSetting(db, 'review_threshold'),
    message: {
      id: m.id,
      chatId: m.chatId,
      sentAt: m.sentAt,
      fromHistory: m.origin === 'history',
      cardLink:
        db.get<{ cardId: Id | null; setBy: SetBy }>(
          'SELECT card_id AS cardId,set_by AS setBy FROM card_message WHERE message_id=?',
          messageId,
        ) ?? null,
    },
    activeLaneIds: db
      .all<{ id: Id }>('SELECT id FROM lane WHERE archived_at IS NULL ORDER BY position,id')
      .map((l) => l.id),
    stages: db.all(
      'SELECT s.id,s.lane_id AS laneId FROM stage s JOIN lane l ON l.id=s.lane_id WHERE l.archived_at IS NULL AND s.removed_at IS NULL',
    ),
    cards: db
      .all<{
        id: Id;
        laneId: Id;
        archived: number;
        stageHumanSetAt: string | null;
        textSetBy: SetBy;
        needsText: number;
        companySetBy: SetBy | null;
      }>(
        'SELECT id,lane_id AS laneId,archived_at IS NOT NULL AS archived,stage_human_set_at AS stageHumanSetAt,text_set_by AS textSetBy,needs_text AS needsText,company_set_by AS companySetBy FROM card',
      )
      .map((c) => ({
        ...c,
        archived: Boolean(c.archived),
        needsText: Boolean(c.needsText),
        linkedToChat: Boolean(db.get('SELECT card_id FROM card_chat WHERE card_id=? AND chat_id=?', c.id, m.chatId)),
        offeredToChat: input.cards.some((o) => o.id === c.id && o.link === 'other_chat'),
      })),
    proposals: db.all(
      'SELECT id,status,result_card_id AS resultCardId FROM review_item WHERE kind=? AND chat_id=?',
      'new_card',
      m.chatId,
    ),
    participants: db
      .all<{ contactId: Id; roleSetBy: SetBy; hasHumanCompany: number }>(
        "SELECT DISTINCT c.id AS contactId,c.role_set_by AS roleSetBy,EXISTS(SELECT 1 FROM contact_company cc WHERE cc.contact_id=c.id AND cc.set_by='human') AS hasHumanCompany FROM chat_participant cp JOIN identity i ON i.id=cp.identity_id JOIN contact c ON c.id=i.contact_id WHERE cp.chat_id=?",
        m.chatId,
      )
      .map((c) => ({ ...c, hasHumanCompany: Boolean(c.hasHumanCompany) })),
    shownCompanyIds: input.companies.map((c) => c.id),
    matches: names.map((name) => ({ name, match: resolveCompany(ctx, name) })),
    removedReferenceCompanyIds: db
      .all<{ id: Id }>('SELECT to_company_id AS id FROM company_reference WHERE message_id=? AND removed=1', messageId)
      .map((c) => c.id),
    validEvidenceIds: db
      .all<{ id: Id }>(
        'SELECT m.id FROM message m JOIN chat ch ON ch.id=m.chat_id WHERE m.chat_id=? AND m.deleted_at IS NULL AND ch.withdrawn_at IS NULL AND (m.sent_at<? OR (m.sent_at=? AND m.id<=?)) ORDER BY m.sent_at DESC,m.id DESC LIMIT 21',
        m.chatId,
        m.sentAt,
        m.sentAt,
        messageId,
      )
      .map((e) => e.id),
    roleCategories: getSetting(db, 'role_categories'),
  };
}

export function moveOutcome(
  move: NonNullable<ModelDecision['move']>,
  cardId: Id,
  facts: GuardFacts,
  dispositionApplied: boolean,
): Outcome {
  const card = facts.cards.find((c) => c.id === cardId),
    stage = facts.stages.find((s) => s.id === move.toStageId);
  if (!card || card.archived || !card.linkedToChat || !stage || stage.laneId !== card.laneId)
    return { do: 'refuse', why: 'invalid_move' };
  const human = card.stageHumanSetAt !== null && facts.message.sentAt <= card.stageHumanSetAt;
  const evidence = [...new Set(move.evidenceMessageIds.filter((id) => facts.validEvidenceIds.includes(id)))];
  if (human || !dispositionApplied || move.confidence <= facts.threshold)
    return {
      do: 'review',
      kind: 'move',
      groupKey: `card:${cardId}`,
      chatId: facts.message.chatId,
      why: human ? 'human_override' : 'low_confidence',
      proposal: { kind: 'move', cardId, toStageId: move.toStageId, criterion: move.criterion },
      confidence: move.confidence,
    };
  return {
    do: 'apply',
    action: {
      type: 'card.move',
      cardId,
      toStageId: move.toStageId,
      criterion: move.criterion,
      evidenceMessageIds: evidence.length ? evidence : [facts.message.id],
    },
    followsHumanOverride: card.stageHumanSetAt !== null,
  };
}

export function judge(decision: ModelDecision, facts: GuardFacts): Outcome[] {
  const p = ModelDecisionSchema.safeParse(decision),
    out: Outcome[] = [];
  const refuse = (why: string): Outcome[] => [{ do: 'refuse', why }];
  if (!p.success) return refuse('invalid_decision');
  const d = p.data;
  const known = (id: Id | null) => id === null || facts.shownCompanyIds.includes(id);
  if (
    (d.cardCompanyId !== null && d.cardCompanyName !== null) ||
    !known(d.cardCompanyId) ||
    d.contacts.some((c) => !known(c.companyId) || (c.companyId !== null && c.companyName !== null)) ||
    d.mentions.some((c) => !known(c.companyId))
  )
    return refuse('unoffered_company');
  if (
    (d.cardId !== null && !facts.cards.some((c) => c.id === d.cardId && (c.linkedToChat || c.offeredToChat))) ||
    (d.proposalId !== null && !facts.proposals.some((r) => r.id === d.proposalId)) ||
    (d.laneId !== null && !facts.activeLaneIds.includes(d.laneId)) ||
    (d.move !== null && !facts.stages.some((s) => s.id === d.move?.toStageId))
  )
    return refuse('unknown_identifier');
  const review = (
    proposal: Extract<Outcome, { do: 'review' }>['proposal'],
    groupKey: string,
    confidence: number,
    why: Extract<Outcome, { do: 'review' }>['why'] = 'low_confidence',
  ) =>
    out.push({ do: 'review', kind: proposal.kind, proposal, groupKey, confidence, why, chatId: facts.message.chatId });
  const apply = (action: Extract<Outcome, { do: 'apply' }>['action']) =>
    out.push({ do: 'apply', action, followsHumanOverride: false });
  const evidence = (ids: Id[]) => {
    const e = [...new Set(ids.filter((id) => facts.validEvidenceIds.includes(id)))];
    return e.length ? e : [facts.message.id];
  };
  const match = (name: string) => facts.matches.find((m) => m.name === name)?.match;
  let disposition = d.disposition,
    cardId = d.cardId,
    dispositionApplied = false;
  if (disposition === 'join') {
    const r = facts.proposals.find((r) => r.id === d.proposalId);
    if (!r) return refuse('unknown_proposal');
    if (r.status === 'open')
      disposition = 'none'; // Fresh Agent review-group join is handled privately by the pipeline.
    else if (r.resultCardId !== null) {
      disposition = 'attach';
      cardId = r.resultCardId;
    } else disposition = 'none';
  }
  if (
    d.contacts.some((c) => c.evidenceMessageIds.some((id) => !facts.validEvidenceIds.includes(id))) ||
    d.move?.evidenceMessageIds.some((id) => !facts.validEvidenceIds.includes(id))
  )
    return refuse('invalid_evidence');
  const human = facts.message.cardLink?.setBy === 'human';
  if (disposition === 'create') {
    if (d.laneId === null || !d.title || !d.summary?.trim()) return refuse('invalid_create');
    const m = d.cardCompanyName === null ? undefined : match(d.cardCompanyName);
    const companyId =
      d.cardCompanyName === null ? d.cardCompanyId : m && ['exact', 'alias'].includes(m.match) ? m.companyId : null;
    if (!human && d.confidence > facts.threshold) {
      apply({
        type: 'card.create',
        laneId: d.laneId,
        title: d.title,
        summary: d.summary,
        chatId: facts.message.chatId,
        messageId: facts.message.id,
        companyId,
        fromHistory: facts.message.fromHistory,
      });
      dispositionApplied = true;
    } else
      review(
        { kind: 'new_card', laneId: d.laneId, title: d.title, summary: d.summary, companyId, move: null },
        `chat:${facts.message.chatId}:first:${facts.message.id}`,
        d.confidence,
        human ? 'human_override' : 'low_confidence',
      );
  } else if (disposition === 'attach') {
    const c = facts.cards.find((c) => c.id === cardId);
    if (!c || c.archived || !facts.activeLaneIds.includes(c.laneId) || (!c.linkedToChat && !c.offeredToChat))
      return refuse('unoffered_card');
    if (c.needsText && c.textSetBy !== 'human' && (!d.title?.trim() || !d.summary?.trim()))
      return refuse('invalid_refill');
    const title = c.textSetBy === 'human' || !c.needsText ? null : d.title,
      summary = c.textSetBy === 'human' ? null : d.summary;
    const m = d.cardCompanyName === null ? undefined : match(d.cardCompanyName);
    const companyId =
      c.companySetBy === 'human'
        ? null
        : d.cardCompanyName === null
          ? d.cardCompanyId
          : m && ['exact', 'alias'].includes(m.match)
            ? m.companyId
            : null;
    if (!human && c.linkedToChat && d.confidence > facts.threshold) {
      apply({ type: 'message.attach', messageId: facts.message.id, cardId: c.id, title, summary, companyId });
      dispositionApplied = true;
    } else
      review(
        { kind: 'attach', cardId: c.id, summary },
        `chat:${facts.message.chatId}:card:${c.id}`,
        d.confidence,
        !c.linkedToChat ? 'cross_chat' : human ? 'human_override' : 'low_confidence',
      );
  } else if (d.disposition !== 'join' && d.confidence <= facts.threshold)
    review({ kind: 'is_work' }, `chat:${facts.message.chatId}`, d.confidence);
  if (d.move && cardId !== null) out.push(moveOutcome(d.move, cardId, facts, dispositionApplied));
  for (const c of d.contacts) {
    const participant = facts.participants.find((p) => p.contactId === c.contactId);
    if (!participant) {
      out.push({ do: 'refuse', why: 'unoffered_contact' });
      continue;
    }
    const ids = evidence(c.evidenceMessageIds);
    if (c.companyId !== null || c.companyName !== null) {
      const m = c.companyName === null ? undefined : match(c.companyName);
      if (c.companyName !== null && m?.match === 'similar' && m.companyId !== null)
        review(
          {
            kind: 'name_company',
            name: c.companyName,
            companyId: m.companyId,
            held: [{ use: 'contact_company', contactId: c.contactId, evidenceMessageIds: ids }],
          },
          `name:${normalizeCompanyName(c.companyName)}:company:${m.companyId}`,
          c.companyConfidence,
          'similar_name',
        );
      else {
        const company =
          c.companyId !== null
            ? { id: c.companyId }
            : m?.companyId != null && ['exact', 'alias'].includes(m.match)
              ? { id: m.companyId }
              : { name: c.companyName ?? '' };
        if (!participant.hasHumanCompany && c.companyConfidence > facts.threshold)
          apply({ type: 'contact.set_company', contactId: c.contactId, company, evidenceMessageIds: ids });
        else
          review(
            { kind: 'contact_company', contactId: c.contactId, company },
            `contact:${c.contactId}`,
            c.companyConfidence,
            participant.hasHumanCompany ? 'human_override' : 'low_confidence',
          );
      }
    }
    if (c.roleCategory !== null) {
      if (!facts.roleCategories.includes(c.roleCategory) || c.dealsAbout === null) {
        out.push({ do: 'refuse', why: 'invalid_role' });
        continue;
      }
      if (participant.roleSetBy !== 'human' && c.roleConfidence > facts.threshold)
        apply({
          type: 'contact.set_role',
          contactId: c.contactId,
          category: c.roleCategory,
          dealsAbout: c.dealsAbout,
          evidenceMessageIds: ids,
        });
      else
        review(
          { kind: 'contact_role', contactId: c.contactId, category: c.roleCategory, dealsAbout: c.dealsAbout },
          `contact:${c.contactId}`,
          c.roleConfidence,
          participant.roleSetBy === 'human' ? 'human_override' : 'low_confidence',
        );
    }
  }
  for (const mention of d.mentions) {
    const m = match(mention.name),
      id = mention.companyId ?? m?.companyId ?? null;
    if (id !== null && facts.removedReferenceCompanyIds.includes(id)) continue;
    if (id === null || m?.match === 'none') {
      out.push({ do: 'pending_mention', name: mention.name, confidence: mention.confidence });
      continue;
    }
    if (m?.match === 'similar' || mention.confidence <= facts.threshold)
      review(
        {
          kind: 'name_company',
          name: mention.name,
          companyId: id,
          held: [{ use: 'reference', messageId: facts.message.id }],
        },
        `name:${normalizeCompanyName(mention.name)}:company:${id}`,
        mention.confidence,
        m?.match === 'similar' ? 'similar_name' : 'low_confidence',
      );
    else apply({ type: 'reference.record', toCompanyId: id, messageId: facts.message.id });
  }
  return out;
}
