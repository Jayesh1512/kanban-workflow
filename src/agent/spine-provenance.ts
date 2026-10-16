import { createHash } from 'node:crypto';
import type { AgentWorkScope, Ctx, DecideInput, Id } from '../contracts/index.ts';

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function inputProvenance(ctx: Ctx, input: DecideInput, chatEligible: (id: Id) => boolean) {
  const { db } = ctx;
  const messages = new Set([input.message.id, ...input.recent.map((m) => m.id)]);
  const chats = new Set([input.chat.id]);
  const cardIds = JSON.stringify(input.cards.map((c) => c.id));
  const proposalIds = JSON.stringify(input.proposals.map((p) => p.id));
  const contactIds = JSON.stringify(input.participants.map((p) => p.contactId));
  const companyIds = JSON.stringify(input.companies.map((c) => c.id));
  const participantCompanyIds = JSON.stringify([...new Set(input.participants.flatMap((p) => p.companyIds))]);
  const cards = db.all<{
    id: Id;
    created_from_message_id: Id | null;
    text_set_by: string;
    title: string;
    summary: string;
  }>('SELECT * FROM card WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id', cardIds);
  const cardMessages = db.all<{ card_id: Id; message_id: Id }>(
    'SELECT * FROM card_message WHERE card_id IN (SELECT value FROM json_each(?)) ORDER BY card_id,message_id',
    cardIds,
  );
  for (const c of cards) {
    if (c.created_from_message_id !== null) messages.add(c.created_from_message_id);
    if (
      c.text_set_by === 'agent' &&
      (c.title || c.summary) &&
      c.created_from_message_id === null &&
      !cardMessages.some((m) => m.card_id === c.id)
    )
      return null;
  }
  for (const m of cardMessages) messages.add(m.message_id);
  const cardChats = db.all<{ chat_id: Id }>(
    'SELECT * FROM card_chat WHERE card_id IN (SELECT value FROM json_each(?)) ORDER BY card_id,chat_id',
    cardIds,
  );
  for (const ch of cardChats) chats.add(ch.chat_id);
  const proposals = db.all(
    'SELECT * FROM review_item WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id',
    proposalIds,
  );
  const reviewMessages = db.all<{ review_item_id: Id; message_id: Id; decision_id: Id | null }>(
    'SELECT * FROM review_message WHERE review_item_id IN (SELECT value FROM json_each(?)) ORDER BY review_item_id,message_id',
    proposalIds,
  );
  for (const m of reviewMessages) messages.add(m.message_id);
  if (input.proposals.some((p) => !reviewMessages.some((m) => m.review_item_id === p.id))) return null;
  const decisions = db.all<{ message_id: Id }>(
    'SELECT * FROM decision WHERE id IN (SELECT decision_id FROM review_message WHERE review_item_id IN (SELECT value FROM json_each(?))) ORDER BY id',
    proposalIds,
  );
  for (const d of decisions) messages.add(d.message_id);
  const audits = db.all<{ snapshot: string; result: string }>(
    'SELECT * FROM movement_decision WHERE decision_id IN (SELECT decision_id FROM review_message WHERE review_item_id IN (SELECT value FROM json_each(?))) ORDER BY decision_id',
    proposalIds,
  );
  // Stored private audits contribute only their actual evidence/message identifiers, never lane/card IDs.
  function auditMessages(value: unknown, key = ''): void {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (
          ['messageIds', 'evidenceMessageIds', 'supportingMessageIds'].includes(key) &&
          typeof item === 'number' &&
          Number.isSafeInteger(item) &&
          item > 0
        )
          messages.add(item);
        else auditMessages(item, key);
      }
    } else if (value !== null && typeof value === 'object') {
      for (const [name, item] of Object.entries(value)) {
        if (
          (name === 'messageId' || (name === 'id' && key === 'evidence')) &&
          typeof item === 'number' &&
          Number.isSafeInteger(item) &&
          item > 0
        )
          messages.add(item);
        else auditMessages(item, name);
      }
    }
  }
  for (const audit of audits) {
    auditMessages(JSON.parse(audit.snapshot));
    auditMessages(JSON.parse(audit.result));
  }
  const participants = db.all<{
    first_seen_at: string;
    identity_id: Id;
    id: Id;
    role_set_by: string;
    role_category: string;
    deals_about: string;
  }>(
    'SELECT cp.*,i.*,c.* FROM chat_participant cp JOIN identity i ON i.id=cp.identity_id JOIN contact c ON c.id=i.contact_id WHERE cp.chat_id=? AND c.id IN (SELECT value FROM json_each(?)) ORDER BY i.id',
    input.chat.id,
    contactIds,
  );
  for (const p of participants) {
    const first = db.get<{ id: Id }>(
      'SELECT id FROM message WHERE chat_id=? AND sender_identity_id=? AND sent_at=? ORDER BY id LIMIT 1',
      input.chat.id,
      p.identity_id,
      p.first_seen_at,
    );
    if (first) messages.add(first.id);
  }
  const links = db.all<{ contact_id: Id; company_id: Id; set_by: string; removed: number }>(
    'SELECT * FROM contact_company WHERE contact_id IN (SELECT value FROM json_each(?)) ORDER BY contact_id,company_id',
    contactIds,
  );
  const evidence = db.all<{ contact_id: Id; company_id: Id | null; kind: string; message_id: Id }>(
    `SELECT * FROM evidence WHERE contact_id IN (SELECT value FROM json_each(?))
     AND (kind='contact_role' OR company_id IN (SELECT value FROM json_each(?))) ORDER BY id`,
    contactIds,
    participantCompanyIds,
  );
  if (
    participants.some(
      (p) =>
        p.role_set_by === 'agent' &&
        (p.role_category !== 'unknown' || p.deals_about) &&
        !evidence.some((e) => e.contact_id === p.id && e.kind === 'contact_role'),
    )
  )
    return null;
  if (
    links.some(
      (l) =>
        l.set_by === 'agent' &&
        l.removed === 0 &&
        !evidence.some(
          (e) => e.contact_id === l.contact_id && e.company_id === l.company_id && e.kind === 'contact_company',
        ),
    )
  )
    return null;
  for (const e of evidence) messages.add(e.message_id);
  const companies = db.all(
    'SELECT * FROM company WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id',
    companyIds,
  );
  const aliases = db.all(
    'SELECT * FROM company_alias WHERE company_id IN (SELECT value FROM json_each(?)) ORDER BY alias_norm',
    companyIds,
  );
  const references = db.all<{ message_id: Id }>(
    'SELECT * FROM company_reference WHERE removed=0 AND (from_company_id IN (SELECT value FROM json_each(?)) OR to_company_id IN (SELECT value FROM json_each(?))) ORDER BY id',
    companyIds,
    companyIds,
  );
  for (const r of references) messages.add(r.message_id);
  const sources = [];
  for (const id of [...messages].sort((a, b) => a - b)) {
    const m = db.get<{ chat_id: Id; deleted_at: string | null }>('SELECT * FROM message WHERE id=?', id);
    if (!m || m.deleted_at !== null) return null;
    chats.add(m.chat_id);
    sources.push(m);
  }
  const authority = [];
  for (const id of [...chats].sort((a, b) => a - b)) {
    if (!chatEligible(id)) return null;
    authority.push({
      chat: db.get('SELECT * FROM chat WHERE id=?', id),
      owners: db.all(
        `SELECT ac.account_id,ac.sync_state,ac.agreement_stale_since,ca.state,ca.teammate_id,t.removed_at,cs.decision
         FROM account_chat ac JOIN channel_account ca ON ca.id=ac.account_id JOIN teammate t ON t.id=ca.teammate_id
         JOIN chat ch ON ch.id=ac.chat_id JOIN chat_selection cs ON cs.account_id=ca.id AND cs.chat_key=ch.chat_key
         WHERE ac.chat_id=? ORDER BY ac.account_id`,
        id,
      ),
    });
  }
  const scope: AgentWorkScope = {
    chatIds: [...chats].sort((a, b) => a - b),
    messageIds: [...messages].sort((a, b) => a - b),
  };
  return {
    scope,
    hash: digest({
      cards,
      cardMessages,
      cardChats,
      proposals,
      reviewMessages,
      decisions,
      audits,
      participants,
      links,
      evidence,
      companies,
      aliases,
      references,
      sources,
      authority,
    }),
  };
}
