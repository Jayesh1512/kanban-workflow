import { getSetting } from '../auth/index.ts';
import { attachMessage, createCard, moveCard } from '../board/index.ts';
import type { Ctx, DecideInput, Id, ModelDecision, ReviewProposal, WriteOpts } from '../contracts/index.ts';
import { AppError, ReviewProposalSchema } from '../contracts/index.ts';
import { setContactCompany, setContactRole } from '../graph/index.ts';
import { record } from '../log/index.ts';

export function spineActions(
  ctx: Ctx,
  input: DecideInput,
  d: ModelDecision,
  decisionId: Id,
): 'applied' | 'review' | 'mixed' | 'none' {
  const threshold = getSetting<number>(ctx.db, 'review_threshold');
  let applied = 0;
  let reviewed = 0;
  const o: WriteOpts = { setBy: 'agent', reason: d.reason, decisionId };
  function review(
    proposal: ReviewProposal,
    groupKey: string,
    confidence: number,
    why: 'low_confidence' | 'human_override' = 'low_confidence',
  ): Id {
    const existing = ctx.db.get<{ id: Id }>(
      "SELECT id FROM review_item WHERE kind=? AND group_key=? AND status='open'",
      proposal.kind,
      groupKey,
    );
    const at = ctx.now().toISOString();
    const id =
      existing?.id ??
      ctx.db.run(
        "INSERT INTO review_item(kind,group_key,chat_id,proposal,why,confidence,reason,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'open',?,?)",
        proposal.kind,
        groupKey,
        input.chat.id,
        JSON.stringify(proposal),
        why,
        confidence,
        d.reason,
        at,
        at,
      ).lastInsertRowid;
    if (existing)
      ctx.db.run(
        'UPDATE review_item SET proposal=?,confidence=?,reason=?,updated_at=? WHERE id=?',
        JSON.stringify(proposal),
        confidence,
        d.reason,
        at,
        id,
      );
    ctx.db.run(
      'INSERT OR IGNORE INTO review_message(review_item_id,message_id,decision_id) VALUES (?,?,?)',
      id,
      input.message.id,
      decisionId,
    );
    record(ctx, {
      action: existing ? 'review.join' : 'review.create',
      subjectKind: 'review',
      subjectId: id,
      after: { proposal, confidence, why },
      reason: d.reason,
      messageIds: [input.message.id],
      decisionId,
    });
    reviewed++;
    return id;
  }
  if (d.mentions.length) throw new AppError('invalid', 'not built: processNext');
  let cardId: Id | null = null;
  let proposalId: Id | null = null;
  let dispositionApplied = false;
  if (d.disposition === 'create') {
    if (
      d.laneId === null ||
      !input.lanes.some((l) => l.id === d.laneId) ||
      d.title === null ||
      d.summary === null ||
      d.summary.length === 0
    )
      throw new AppError('invalid', 'Invalid create decision');
    const companyId =
      d.cardCompanyId ??
      (d.cardCompanyName === null
        ? null
        : (input.companies.find((c) => c.name.toLowerCase() === d.cardCompanyName?.toLowerCase())?.id ?? null));
    if (d.confidence > threshold) {
      cardId = createCard(
        ctx,
        {
          laneId: d.laneId,
          title: d.title,
          summary: d.summary,
          companyId,
          chatId: input.chat.id,
          messageId: input.message.id,
          fromHistory:
            ctx.db.get<{ origin: string }>('SELECT origin FROM message WHERE id=?', input.message.id)?.origin ===
            'history',
        },
        o,
      ).id;
      applied++;
      dispositionApplied = true;
    } else
      proposalId = review(
        {
          kind: 'new_card',
          laneId: d.laneId,
          title: d.title,
          summary: d.summary,
          companyId,
          move: d.move === null ? null : { toStageId: d.move.toStageId, criterion: d.move.criterion },
        },
        `chat:${input.chat.id}:first:${input.message.id}`,
        d.confidence,
      );
  } else if (d.disposition === 'attach') {
    if (d.cardId === null || !input.cards.some((c) => c.id === d.cardId))
      throw new AppError('invalid', 'Card is outside spine chat');
    if (d.title !== null || d.summary !== null || d.cardCompanyName !== null || d.cardCompanyId !== null)
      throw new AppError('invalid', 'not built: processNext');
    if (d.confidence > threshold) {
      attachMessage(ctx, input.message.id, d.cardId, o);
      cardId = d.cardId;
      applied++;
      dispositionApplied = true;
    } else {
      cardId = d.cardId;
      review(
        { kind: 'attach', cardId: d.cardId, summary: null },
        `chat:${input.chat.id}:card:${d.cardId}`,
        d.confidence,
      );
    }
  } else if (d.disposition === 'join') {
    if (d.proposalId === null) throw new AppError('invalid', 'Proposal required');
    const row = ctx.db.get<{ proposal: string; status: string; result_card_id: Id | null }>(
      'SELECT proposal,status,result_card_id FROM review_item WHERE id=? AND chat_id=?',
      d.proposalId,
      input.chat.id,
    );
    if (!row) throw new AppError('invalid', 'Proposal is outside spine chat');
    if (row.status === 'open') {
      const proposal = ReviewProposalSchema.parse(JSON.parse(row.proposal));
      if (proposal.kind !== 'new_card') throw new AppError('invalid', 'not built: processNext');
      if (d.summary !== null) proposal.summary = d.summary;
      if (d.move !== null) proposal.move = { toStageId: d.move.toStageId, criterion: d.move.criterion };
      ctx.db.run(
        'UPDATE review_item SET proposal=?,updated_at=? WHERE id=?',
        JSON.stringify(proposal),
        ctx.now().toISOString(),
        d.proposalId,
      );
      ctx.db.run(
        'INSERT OR IGNORE INTO review_message(review_item_id,message_id,decision_id) VALUES (?,?,?)',
        d.proposalId,
        input.message.id,
        decisionId,
      );
      record(ctx, {
        action: 'review.join',
        subjectKind: 'review',
        subjectId: d.proposalId,
        before: { proposal: JSON.parse(row.proposal) as unknown },
        after: { proposal },
        reason: d.reason,
        messageIds: [input.message.id],
        decisionId,
      });
      proposalId = d.proposalId;
      reviewed++;
    } else if (row.result_card_id !== null) {
      if (d.confidence > threshold) {
        attachMessage(ctx, input.message.id, row.result_card_id, o);
        cardId = row.result_card_id;
        applied++;
        dispositionApplied = true;
      } else {
        cardId = row.result_card_id;
        review(
          { kind: 'attach', cardId: row.result_card_id, summary: null },
          `chat:${input.chat.id}:card:${row.result_card_id}`,
          d.confidence,
        );
      }
    }
  } else if (d.confidence <= threshold) review({ kind: 'is_work' }, `chat:${input.chat.id}`, d.confidence);
  if (d.move !== null) {
    const stage = input.lanes
      .flatMap((l) => l.stages.map((s) => ({ ...s, laneId: l.id })))
      .find((s) => s.id === d.move?.toStageId);
    const laneId =
      cardId === null
        ? proposalId === null
          ? null
          : (d.laneId ?? input.proposals.find((p) => p.id === proposalId)?.laneId)
        : ctx.db.get<{ lane_id: Id }>('SELECT lane_id FROM card WHERE id=?', cardId)?.lane_id;
    if (!stage || stage.laneId !== laneId) throw new AppError('invalid', 'Cross-lane movement is outside spine');
    if (input.lanes.some((l) => l.id !== laneId)) throw new AppError('invalid', 'not built: processNext');
    if (proposalId === null && cardId !== null) {
      if (d.move.confidence > threshold && dispositionApplied) {
        moveCard(
          ctx,
          cardId,
          { stageId: d.move.toStageId, criterion: d.move.criterion, evidenceMessageIds: d.move.evidenceMessageIds },
          o,
        );
        applied++;
      } else
        review(
          { kind: 'move', cardId, toStageId: d.move.toStageId, criterion: d.move.criterion },
          `card:${cardId}`,
          d.move.confidence,
        );
    }
  }
  for (const c of d.contacts) {
    const p = input.participants.find((p) => p.contactId === c.contactId);
    if (!p) throw new AppError('invalid', 'Contact is outside spine chat');
    if (c.companyId !== null || c.companyName !== null) {
      const company = c.companyId === null ? { name: c.companyName as string } : { id: c.companyId };
      if (c.companyConfidence > threshold) {
        setContactCompany(ctx, c.contactId, { company, evidenceMessageIds: c.evidenceMessageIds }, o);
        applied++;
      } else
        review(
          { kind: 'contact_company', contactId: c.contactId, company },
          `contact:${c.contactId}`,
          c.companyConfidence,
        );
    }
    if (c.roleCategory !== null) {
      if (!input.roleCategories.includes(c.roleCategory) || c.dealsAbout === null)
        throw new AppError('invalid', 'Invalid role decision');
      if (c.roleConfidence > threshold) {
        setContactRole(
          ctx,
          c.contactId,
          { category: c.roleCategory, dealsAbout: c.dealsAbout, evidenceMessageIds: c.evidenceMessageIds },
          o,
        );
        applied++;
      } else
        review(
          { kind: 'contact_role', contactId: c.contactId, category: c.roleCategory, dealsAbout: c.dealsAbout },
          `contact:${c.contactId}`,
          c.roleConfidence,
        );
    }
  }
  return applied ? (reviewed ? 'mixed' : 'applied') : reviewed ? 'review' : 'none';
}
