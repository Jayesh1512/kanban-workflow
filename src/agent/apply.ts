import { attachMessage, createCard, moveCard, updateCard } from '../board/index.ts';
import type { Action, Ctx, Id, SetBy } from '../contracts/index.ts';
import { ActionSchema, AppError } from '../contracts/index.ts';
import { recordReference, setContactCompany, setContactRole } from '../graph/index.ts';

export function applyOwnedAction(
  ctx: Ctx,
  action: Action,
  o: { decisionId: Id | null; reason: string; setBy: SetBy; followsHumanOverride: boolean },
): Id | null {
  if (!ActionSchema.safeParse(action).success) throw new AppError('invalid', 'Invalid agent action');
  const opts = { decisionId: o.decisionId, reason: o.reason, setBy: o.setBy };
  switch (action.type) {
    case 'card.create':
      return createCard(
        ctx,
        {
          laneId: action.laneId,
          title: action.title,
          summary: action.summary,
          chatId: action.chatId,
          messageId: action.messageId,
          companyId: action.companyId,
          fromHistory: action.fromHistory,
        },
        opts,
      ).id;
    case 'message.attach': {
      attachMessage(ctx, action.messageId, action.cardId, opts);
      const row = ctx.db.get<{ text_set_by: SetBy; company_set_by: SetBy | null; needs_text: number }>(
        'SELECT text_set_by,company_set_by,needs_text FROM card WHERE id=?',
        action.cardId,
      );
      if (!row) throw new AppError('not_found', 'Card not found');
      const fields: { title?: string; summary?: string; companyId?: Id } = {};
      if (row.text_set_by !== 'human') {
        if (row.needs_text && action.title !== null) fields.title = action.title;
        if (action.summary !== null) fields.summary = action.summary;
      }
      if (row.company_set_by !== 'human' && action.companyId !== null) fields.companyId = action.companyId;
      if (Object.keys(fields).length) updateCard(ctx, action.cardId, fields, opts);
      return action.cardId;
    }
    case 'card.move':
      moveCard(
        ctx,
        action.cardId,
        {
          stageId: action.toStageId,
          criterion: action.criterion,
          evidenceMessageIds: action.evidenceMessageIds,
          followsHumanOverride: o.followsHumanOverride,
        },
        opts,
      );
      return action.cardId;
    case 'contact.set_company':
      setContactCompany(
        ctx,
        action.contactId,
        { company: action.company, evidenceMessageIds: action.evidenceMessageIds },
        opts,
      );
      return null;
    case 'contact.set_role':
      setContactRole(
        ctx,
        action.contactId,
        { category: action.category, dealsAbout: action.dealsAbout, evidenceMessageIds: action.evidenceMessageIds },
        opts,
      );
      return null;
    case 'reference.record': {
      const card = ctx.db.get<{ id: Id; company_id: Id | null }>(
        'SELECT c.id,c.company_id FROM card_message cm JOIN card c ON c.id=cm.card_id WHERE cm.message_id=?',
        action.messageId,
      );
      const companies = ctx.db.all<{ id: Id }>(
        'SELECT DISTINCT cc.company_id AS id FROM message m JOIN identity i ON i.id=m.sender_identity_id JOIN contact_company cc ON cc.contact_id=i.contact_id WHERE m.id=? AND cc.removed=0',
        action.messageId,
      );
      recordReference(
        ctx,
        {
          toCompanyId: action.toCompanyId,
          messageId: action.messageId,
          cardId: card?.id ?? null,
          fromCompanyId: card?.company_id ?? (companies.length === 1 ? (companies[0]?.id ?? null) : null),
        },
        opts,
      );
      return null;
    }
  }
}
export function applyAction(
  ctx: Ctx,
  action: Action,
  o: { decisionId: Id | null; reason: string; setBy: SetBy; followsHumanOverride: boolean },
): void {
  applyOwnedAction(ctx, action, o);
}
