import { z } from 'zod';
import { getSetting } from '../auth/index.ts';
import type { CompanyRef, Ctx, Id, SetBy, WriteOpts } from '../contracts/index.ts';
import { AppError, CompanyRefSchema, IdSchema } from '../contracts/index.ts';
import { record } from '../log/index.ts';
import { ensureParticipantCompany } from './companies.ts';
import { by, human, validate } from './helpers.ts';

function contact(ctx: Ctx, id: Id): { role_category: string; deals_about: string; role_set_by: SetBy } {
  validate(IdSchema, id);
  const r = ctx.db.get<{ role_category: string; deals_about: string; role_set_by: SetBy }>(
    'SELECT role_category,deals_about,role_set_by FROM contact WHERE id=?',
    id,
  );
  if (!r) throw new AppError('not_found', 'Contact not found');
  return r;
}
function evidence(ctx: Ctx, contactId: Id, ids: Id[]): void {
  validate(z.array(IdSchema), ids);
  for (const id of ids)
    if (
      !ctx.db.get(
        'SELECT m.id FROM message m JOIN chat_participant cp ON cp.chat_id=m.chat_id JOIN identity i ON i.id=cp.identity_id WHERE m.id=? AND i.contact_id=? AND m.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM chat WHERE id=m.chat_id AND withdrawn_at IS NOT NULL)',
        id,
        contactId,
      )
    )
      throw new AppError('invalid', 'Evidence is outside contact chats');
}
export function setContactCompany(
  ctx: Ctx,
  contactId: Id,
  i: { company: CompanyRef; evidenceMessageIds: Id[] },
  o?: WriteOpts,
): void {
  validate(z.strictObject({ company: CompanyRefSchema, evidenceMessageIds: z.array(IdSchema) }), i);
  const setBy = by(ctx, o);
  ctx.db.tx(() => {
    contact(ctx, contactId);
    evidence(ctx, contactId, i.evidenceMessageIds);
    if (ctx.actor.kind === 'agent' && i.evidenceMessageIds.length === 0)
      throw new AppError('invalid', 'Company needs participant evidence');
    if (
      ctx.actor.kind === 'agent' &&
      ctx.db.get("SELECT company_id FROM contact_company WHERE contact_id=? AND set_by='human'", contactId)
    )
      throw new AppError('forbidden', 'Human company links are locked');
    const companyId = 'id' in i.company ? i.company.id : ensureParticipantCompany(ctx, i.company.name);
    if (!ctx.db.get('SELECT id FROM company WHERE id=?', companyId))
      throw new AppError('not_found', 'Company not found');
    const old = ctx.db.get<{ set_by: SetBy; removed: number }>(
      'SELECT set_by,removed FROM contact_company WHERE contact_id=? AND company_id=?',
      contactId,
      companyId,
    );
    if (setBy === 'agent' && old?.set_by === 'human') throw new AppError('forbidden', 'Human company link is locked');
    ctx.db.run(
      'INSERT INTO contact_company(contact_id,company_id,set_by,removed) VALUES (?,?,?,0) ON CONFLICT(contact_id,company_id) DO UPDATE SET set_by=excluded.set_by,removed=0',
      contactId,
      companyId,
      setBy,
    );
    ctx.db.run(
      "DELETE FROM evidence WHERE kind='contact_company' AND contact_id=? AND company_id=?",
      contactId,
      companyId,
    );
    for (const id of new Set(i.evidenceMessageIds))
      ctx.db.run(
        "INSERT INTO evidence(kind,contact_id,company_id,message_id) VALUES ('contact_company',?,?,?)",
        contactId,
        companyId,
        id,
      );
    record(ctx, {
      action: 'contact.set_company',
      subjectKind: 'contact',
      subjectId: contactId,
      before: old ?? null,
      after: { companyId, setBy },
      reason: o?.reason,
      messageIds: i.evidenceMessageIds,
      decisionId: o?.decisionId,
      correctsId: o?.correctsLogId,
    });
  });
}
export function setContactRole(
  ctx: Ctx,
  contactId: Id,
  i: { category: string; dealsAbout: string; evidenceMessageIds: Id[] },
  o?: WriteOpts,
): void {
  validate(z.strictObject({ category: z.string(), dealsAbout: z.string(), evidenceMessageIds: z.array(IdSchema) }), i);
  const setBy = by(ctx, o);
  ctx.db.tx(() => {
    const old = contact(ctx, contactId);
    evidence(ctx, contactId, i.evidenceMessageIds);
    if (!getSetting<string[]>(ctx.db, 'role_categories').includes(i.category))
      throw new AppError('invalid', 'Unknown role category');
    if (i.category !== 'unknown' && i.evidenceMessageIds.length === 0)
      throw new AppError('invalid', 'Role needs evidence');
    if (setBy === 'agent' && old.role_set_by === 'human') throw new AppError('forbidden', 'Human role is locked');
    ctx.db.run(
      'UPDATE contact SET role_category=?,deals_about=?,role_set_by=? WHERE id=?',
      i.category,
      i.dealsAbout,
      setBy,
      contactId,
    );
    ctx.db.run("DELETE FROM evidence WHERE kind='contact_role' AND contact_id=?", contactId);
    for (const id of new Set(i.evidenceMessageIds))
      ctx.db.run("INSERT INTO evidence(kind,contact_id,message_id) VALUES ('contact_role',?,?)", contactId, id);
    record(ctx, {
      action: 'contact.set_role',
      subjectKind: 'contact',
      subjectId: contactId,
      before: { category: old.role_category, dealsAbout: old.deals_about, setBy: old.role_set_by },
      after: { category: i.category, dealsAbout: i.dealsAbout, setBy },
      reason: o?.reason,
      messageIds: i.evidenceMessageIds,
      decisionId: o?.decisionId,
      correctsId: o?.correctsLogId,
    });
  });
}

export function updateContact(ctx: Ctx, contactId: Id, i: { displayName: string }): void {
  human(ctx);
  validate(z.strictObject({ displayName: z.string().trim().min(1) }), i);
  ctx.db.tx(() => {
    contact(ctx, contactId);
    const before = ctx.db.get<{ display_name: string }>('SELECT display_name FROM contact WHERE id=?', contactId);
    ctx.db.run("UPDATE contact SET display_name=?,name_set_by='human' WHERE id=?", i.displayName, contactId);
    record(ctx, {
      action: 'contact.update',
      subjectKind: 'contact',
      subjectId: contactId,
      before: { displayName: before?.display_name },
      after: i,
    });
  });
}

export function removeContactCompany(ctx: Ctx, contactId: Id, companyId: Id): void {
  human(ctx);
  validate(IdSchema, companyId);
  ctx.db.tx(() => {
    contact(ctx, contactId);
    if (!ctx.db.get('SELECT id FROM company WHERE id=?', companyId))
      throw new AppError('not_found', 'Company not found');
    const before = ctx.db.get<{ set_by: SetBy; removed: number }>(
      'SELECT set_by,removed FROM contact_company WHERE contact_id=? AND company_id=?',
      contactId,
      companyId,
    );
    ctx.db.run(
      "INSERT INTO contact_company(contact_id,company_id,set_by,removed) VALUES (?,?,'human',1) ON CONFLICT(contact_id,company_id) DO UPDATE SET set_by='human',removed=1",
      contactId,
      companyId,
    );
    ctx.db.run(
      "DELETE FROM evidence WHERE kind='contact_company' AND contact_id=? AND company_id=?",
      contactId,
      companyId,
    );
    record(ctx, {
      action: 'contact.remove_company',
      subjectKind: 'contact',
      subjectId: contactId,
      before: before ?? null,
      after: { companyId, removed: true },
    });
  });
}
