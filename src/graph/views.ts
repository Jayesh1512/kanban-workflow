import { z } from 'zod';
import { searchCards } from '../board/index.ts';
import type { CompanyView, ContactSummary, ContactView, Ctx, Id, KnownCompanyPanel } from '../contracts/index.ts';
import { AppError, IdSchema } from '../contracts/index.ts';
import { getMessages } from '../ingest/index.ts';
import { validate } from './helpers.ts';

function contactSummary(ctx: Ctx, id: Id): ContactSummary {
  const r = ctx.db.get<{ id: Id; name: string; roleCategory: string; dealsAbout: string }>(
    'SELECT id,display_name AS name,role_category AS roleCategory,deals_about AS dealsAbout FROM contact WHERE id=?',
    id,
  );
  if (!r) throw new AppError('not_found', 'Contact not found');
  return {
    ...r,
    companies: ctx.db.all(
      'SELECT co.id,co.name FROM company co JOIN contact_company cc ON cc.company_id=co.id WHERE cc.contact_id=? AND cc.removed=0 ORDER BY co.id',
      id,
    ),
  };
}
function contactChats(ctx: Ctx, id: Id): { id: Id; title: string; lastMessageAt: string | null }[] {
  return ctx.db.all(
    `SELECT DISTINCT ch.id,ch.title,(SELECT max(sent_at) FROM message WHERE chat_id=ch.id) AS lastMessageAt
     FROM chat ch JOIN chat_participant cp ON cp.chat_id=ch.id JOIN identity i ON i.id=cp.identity_id WHERE i.contact_id=? ORDER BY ch.id`,
    id,
  );
}
function companyChats(ctx: Ctx, id: Id): CompanyView['chats'] {
  return ctx.db
    .all<{ id: Id; title: string; lastMessageAt: string | null }>(
      `SELECT ch.id,ch.title,(SELECT max(sent_at) FROM message WHERE chat_id=ch.id) AS lastMessageAt FROM chat ch
     WHERE ch.named_company_id=? OR EXISTS (SELECT 1 FROM chat_participant cp JOIN identity i ON i.id=cp.identity_id JOIN contact_company cc ON cc.contact_id=i.contact_id WHERE cp.chat_id=ch.id AND cc.company_id=? AND cc.removed=0)
     OR EXISTS (SELECT 1 FROM card_chat cch JOIN card c ON c.id=cch.card_id WHERE cch.chat_id=ch.id AND c.company_id=?) ORDER BY ch.id`,
      id,
      id,
      id,
    )
    .map((c) => ({
      ...c,
      teammates: ctx.db.all(
        'SELECT DISTINCT t.id,t.display_name AS name FROM account_chat ac JOIN channel_account a ON a.id=ac.account_id JOIN teammate t ON t.id=a.teammate_id WHERE ac.chat_id=? ORDER BY t.id',
        c.id,
      ),
    }));
}
function last(chats: { lastMessageAt: string | null }[]): string | null {
  return (
    chats
      .map((c) => c.lastMessageAt)
      .filter((at): at is string => at !== null)
      .sort()
      .at(-1) ?? null
  );
}

export function searchContacts(
  ctx: Ctx,
  q: { companyId?: Id; roleCategory?: string; text?: string; limit?: number; offset?: number },
): ContactSummary[] {
  validate(
    z.strictObject({
      companyId: IdSchema.optional(),
      roleCategory: z.string().optional(),
      text: z.string().optional(),
      limit: z.number().int().positive().safe().optional(),
      offset: z.number().int().nonnegative().safe().optional(),
    }),
    q,
  );
  return ctx.db
    .all<{ id: Id }>(
      `SELECT c.id FROM contact c WHERE (? IS NULL OR EXISTS (SELECT 1 FROM contact_company cc WHERE cc.contact_id=c.id AND cc.company_id=? AND cc.removed=0))
      AND (? IS NULL OR c.role_category=?) AND (? IS NULL OR instr(lower(c.display_name),lower(?))>0 OR instr(lower(c.deals_about),lower(?))>0
       OR EXISTS (SELECT 1 FROM identity i WHERE i.contact_id=c.id AND (instr(lower(i.display_name),lower(?))>0 OR instr(lower(coalesce(i.handle,'')),lower(?))>0)))
      ORDER BY c.display_name,c.id LIMIT ? OFFSET ?`,
      q.companyId ?? null,
      q.companyId ?? null,
      q.roleCategory ?? null,
      q.roleCategory ?? null,
      q.text ?? null,
      q.text ?? null,
      q.text ?? null,
      q.text ?? null,
      q.text ?? null,
      q.limit ?? 50,
      q.offset ?? 0,
    )
    .map((c) => contactSummary(ctx, c.id));
}
export function searchCompanies(
  ctx: Ctx,
  q: { text?: string; limit?: number },
): { id: Id; name: string; contactCount: number }[] {
  validate(z.strictObject({ text: z.string().optional(), limit: z.number().int().positive().safe().optional() }), q);
  return ctx.db.all(
    `SELECT c.id,c.name,(SELECT count(*) FROM contact_company cc WHERE cc.company_id=c.id AND cc.removed=0) AS contactCount FROM company c
     WHERE (? IS NULL OR instr(lower(c.name),lower(?))>0 OR EXISTS (SELECT 1 FROM company_alias ca WHERE ca.company_id=c.id AND instr(lower(ca.alias),lower(?))>0)) ORDER BY c.name,c.id LIMIT ?`,
    q.text ?? null,
    q.text ?? null,
    q.text ?? null,
    q.limit ?? 50,
  );
}

export function getContact(ctx: Ctx, contactId: Id): ContactView {
  validate(IdSchema, contactId);
  const summary = contactSummary(ctx, contactId),
    chats = contactChats(ctx, contactId);
  const evidence = ctx.db.all<{ kind: string; company_id: Id | null; message_id: Id }>(
    'SELECT kind,company_id,message_id FROM evidence WHERE contact_id=? ORDER BY id',
    contactId,
  );
  const roleIds = evidence.filter((e) => e.kind === 'contact_role').map((e) => e.message_id);
  const companyIds = [
    ...new Set(
      evidence.filter((e) => e.kind === 'contact_company' && e.company_id !== null).map((e) => e.company_id as Id),
    ),
  ];
  return {
    ...summary,
    identities: ctx.db.all(
      'SELECT id,channel,display_name AS displayName,handle FROM identity WHERE contact_id=? ORDER BY id',
      contactId,
    ),
    roleEvidence: getMessages(ctx, { ids: roleIds }),
    companyEvidence: companyIds.map((companyId) => ({
      companyId,
      messages: getMessages(ctx, {
        ids: evidence
          .filter((e) => e.kind === 'contact_company' && e.company_id === companyId)
          .map((e) => e.message_id),
      }),
    })),
    chats,
    lastConversationAt: last(chats),
    recentMessages: getMessages(ctx, { contactId, limit: 50 }),
    cards: searchCards(ctx, { contactId, includeArchived: true, limit: Number.MAX_SAFE_INTEGER }).cards,
  };
}

interface ReferenceRow {
  id: Id;
  from_company_id: Id | null;
  to_company_id: Id;
  message_id: Id;
}
function panel(ctx: Ctx, ref: ReferenceRow): KnownCompanyPanel {
  const company = ctx.db.get<{ id: Id; name: string }>('SELECT id,name FROM company WHERE id=?', ref.to_company_id);
  if (!company) throw new AppError('not_found', 'Company not found');
  const message = getMessages(ctx, { ids: [ref.message_id] })[0];
  if (!message) throw new AppError('not_found', 'Reference message not found');
  return {
    referenceId: ref.id,
    company: { ...company },
    message,
    contacts: searchContacts(ctx, { companyId: company.id, limit: Number.MAX_SAFE_INTEGER }),
    lastConversationAt: last(companyChats(ctx, company.id)),
    openCards: searchCards(ctx, { companyId: company.id, limit: Number.MAX_SAFE_INTEGER }).cards,
  };
}
export function cardReferencePanels(ctx: Ctx, cardId: Id): KnownCompanyPanel[] {
  validate(IdSchema, cardId);
  if (!ctx.db.get('SELECT id FROM card WHERE id=?', cardId)) throw new AppError('not_found', 'Card not found');
  return ctx.db
    .all<ReferenceRow>(
      'SELECT id,from_company_id,to_company_id,message_id FROM company_reference WHERE card_id=? AND removed=0 ORDER BY id',
      cardId,
    )
    .map((ref) => panel(ctx, ref));
}
export function getCompany(ctx: Ctx, companyId: Id): CompanyView {
  validate(IdSchema, companyId);
  const company = ctx.db.get<{ id: Id; name: string }>('SELECT id,name FROM company WHERE id=?', companyId);
  if (!company) throw new AppError('not_found', 'Company not found');
  const chats = companyChats(ctx, companyId);
  return {
    ...company,
    aliases: ctx.db
      .all<{ alias: string }>('SELECT alias FROM company_alias WHERE company_id=? ORDER BY alias', companyId)
      .map((a) => a.alias),
    contacts: searchContacts(ctx, { companyId, limit: Number.MAX_SAFE_INTEGER }),
    chats,
    lastConversationAt: last(chats),
    recentMessages: getMessages(ctx, { companyId, limit: 50 }),
    cards: searchCards(ctx, { companyId, includeArchived: true, limit: Number.MAX_SAFE_INTEGER }).cards,
    referencesOut: ctx.db
      .all<ReferenceRow>(
        'SELECT id,from_company_id,to_company_id,message_id FROM company_reference WHERE from_company_id=? AND removed=0 ORDER BY id',
        companyId,
      )
      .map((ref) => panel(ctx, ref)),
    referencedBy: ctx.db
      .all<ReferenceRow>(
        'SELECT id,from_company_id,to_company_id,message_id FROM company_reference WHERE to_company_id=? AND removed=0 ORDER BY id',
        companyId,
      )
      .map((ref) => {
        const message = getMessages(ctx, { ids: [ref.message_id] })[0];
        if (!message) throw new AppError('not_found', 'Reference message not found');
        const source =
          ref.from_company_id === null
            ? null
            : (ctx.db.get<{ id: Id; name: string }>('SELECT id,name FROM company WHERE id=?', ref.from_company_id) ??
              null);
        return { referenceId: ref.id, company: source === null ? null : { ...source }, message };
      }),
  };
}
