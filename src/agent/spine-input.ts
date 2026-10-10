import { getSetting } from '../auth/index.ts';
import { getBoard } from '../board/index.ts';
import type { Ctx, DecideInput, Id } from '../contracts/index.ts';
import { AppError, ReviewProposalSchema } from '../contracts/index.ts';

export function spineInput(ctx: Ctx, messageId: Id): DecideInput {
  const { db } = ctx;
  const m = db.get<{
    id: Id;
    chat_id: Id;
    message_key: string;
    version: number;
    sent_at: string;
    text: string;
    media: string | null;
    reply_to_message_id: Id | null;
    user_key: string;
    teammate_id: Id | null;
    kind: DecideInput['chat']['kind'];
    title: string;
  }>(
    'SELECT m.*,i.user_key,i.teammate_id,ch.kind,ch.title FROM message m JOIN identity i ON i.id=m.sender_identity_id JOIN chat ch ON ch.id=m.chat_id WHERE m.id=?',
    messageId,
  );
  if (!m) throw new AppError('not_found', 'Message not found');
  const board = getBoard(ctx);
  const proposals = db
    .all<{ id: Id; proposal: string; openedByMessageKey: string; messageCount: number }>(
      "SELECT r.id,r.proposal,(SELECT m.message_key FROM review_message rm JOIN message m ON m.id=rm.message_id WHERE rm.review_item_id=r.id ORDER BY m.sent_at,m.id LIMIT 1) AS openedByMessageKey,(SELECT count(*) FROM review_message WHERE review_item_id=r.id) AS messageCount FROM review_item r WHERE r.chat_id=? AND r.kind='new_card' AND r.status='open' ORDER BY r.id",
      m.chat_id,
    )
    .map((r) => {
      const p = ReviewProposalSchema.parse(JSON.parse(r.proposal));
      if (p.kind !== 'new_card') throw new AppError('invalid', 'Invalid new-card proposal');
      return {
        id: r.id,
        laneId: p.laneId,
        title: p.title,
        summary: p.summary,
        openedByMessageKey: r.openedByMessageKey,
        messageCount: r.messageCount,
      };
    });
  const cards = db
    .all<{
      id: Id;
      laneId: Id;
      stageId: Id;
      title: string;
      summary: string;
      companyId: Id | null;
      needs_text: number;
      createdFromMessageKey: string | null;
      lastMessageAt: string | null;
    }>(
      'SELECT c.id,c.lane_id AS laneId,c.stage_id AS stageId,c.title,c.summary,c.company_id AS companyId,c.needs_text,cm.message_key AS createdFromMessageKey,c.last_message_at AS lastMessageAt FROM card c JOIN card_chat cc ON cc.card_id=c.id LEFT JOIN message cm ON cm.id=c.created_from_message_id WHERE cc.chat_id=? AND c.archived_at IS NULL ORDER BY c.id',
      m.chat_id,
    )
    .map((c) => ({
      id: c.id,
      laneId: c.laneId,
      stageId: c.stageId,
      title: c.title,
      summary: c.summary,
      companyId: c.companyId,
      link: 'this_chat' as const,
      needsText: Boolean(c.needs_text),
      createdFromMessageKey: c.createdFromMessageKey,
      lastMessageAt: c.lastMessageAt,
    }));
  const participants = db
    .all<{ contactId: Id; userKey: string; displayName: string; roleCategory: string; dealsAbout: string }>(
      'SELECT DISTINCT c.id AS contactId,i.user_key AS userKey,c.display_name AS displayName,c.role_category AS roleCategory,c.deals_about AS dealsAbout FROM chat_participant cp JOIN identity i ON i.id=cp.identity_id JOIN contact c ON c.id=i.contact_id WHERE cp.chat_id=? ORDER BY c.id',
      m.chat_id,
    )
    .map((p) => ({
      ...p,
      companyIds: db
        .all<{ id: Id }>(
          'SELECT company_id AS id FROM contact_company WHERE contact_id=? AND removed=0 ORDER BY company_id',
          p.contactId,
        )
        .map((r) => r.id),
    }));
  const named = db.get<{ id: Id | null }>('SELECT named_company_id AS id FROM chat WHERE id=?', m.chat_id)?.id;
  const ids = new Set([
    ...participants.flatMap((p) => p.companyIds),
    ...cards.flatMap((c) => (c.companyId === null ? [] : [c.companyId])),
    ...(named == null ? [] : [named]),
  ]);
  const companies = Array.from(ids)
    .slice(0, 15)
    .map((id) => {
      const r = db.get<{ id: Id; name: string }>('SELECT id,name FROM company WHERE id=?', id);
      if (!r) throw new AppError('not_found', 'Company not found');
      return {
        ...r,
        aliases: db
          .all<{ alias: string }>('SELECT alias FROM company_alias WHERE company_id=?', id)
          .map((a) => a.alias),
        why: participants.some((p) => p.companyIds.includes(id))
          ? ('participant' as const)
          : named === id
            ? ('named' as const)
            : ('card' as const),
      };
    });
  const recent = db
    .all<{
      id: Id;
      key: string;
      sentAt: string;
      senderUserKey: string;
      teammate_id: Id | null;
      text: string;
      cardId: Id | null;
    }>(
      'SELECT m.id,m.message_key AS key,m.sent_at AS sentAt,i.user_key AS senderUserKey,i.teammate_id,m.text,cm.card_id AS cardId FROM message m JOIN identity i ON i.id=m.sender_identity_id LEFT JOIN card_message cm ON cm.message_id=m.id WHERE m.chat_id=? AND (m.sent_at<? OR (m.sent_at=? AND m.id<?)) AND m.deleted_at IS NULL ORDER BY m.sent_at DESC,m.id DESC LIMIT 20',
      m.chat_id,
      m.sent_at,
      m.sent_at,
      m.id,
    )
    .reverse()
    .map((r) => ({
      id: r.id,
      key: r.key,
      sentAt: r.sentAt,
      senderUserKey: r.senderUserKey,
      senderIsTeammate: r.teammate_id !== null,
      text: r.text,
      cardId: r.cardId,
    }));
  return {
    message: {
      id: m.id,
      key: m.message_key,
      version: m.version,
      sentAt: m.sent_at,
      senderUserKey: m.user_key,
      senderIsTeammate: m.teammate_id !== null,
      text: m.text,
      media: m.media,
      replyToId: m.reply_to_message_id,
      currentCardId: null,
    },
    chat: { id: m.chat_id, kind: m.kind, title: m.title },
    recent,
    lanes: board.lanes.map((l) => ({ id: l.id, name: l.name, version: l.version, sop: l.sop, stages: l.stages })),
    cards,
    proposals,
    participants,
    companies,
    roleCategories: getSetting(db, 'role_categories'),
  };
}
