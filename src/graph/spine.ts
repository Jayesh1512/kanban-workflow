import { z } from 'zod';
import { getSetting } from '../auth/index.ts';
import { getBoard } from '../board/index.ts';
import type { CompanyRef, CompanyView, ContactSummary, Ctx, Id, SetBy, WriteOpts } from '../contracts/index.ts';
import { AppError, CompanyRefSchema, IdSchema, ParticipantRefSchema, WriteOptsSchema } from '../contracts/index.ts';
import { getMessages } from '../ingest/index.ts';
import { record } from '../log/index.ts';

function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const p = schema.safeParse(value);
  if (!p.success) throw new AppError('invalid', 'Invalid graph input');
  return p.data;
}
function by(ctx: Ctx, o?: WriteOpts): SetBy {
  if (o) validate(WriteOptsSchema, o);
  const result = o?.setBy ?? (ctx.actor.kind === 'agent' ? 'agent' : 'human');
  if (ctx.actor.kind === 'agent' && result === 'human')
    throw new AppError('forbidden', 'Agent cannot set human values');
  return result;
}
function nameNorm(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
    .replace(/(?:\s+(?:inc|llc|ltd|limited|corp|corporation|co|company|gmbh|pvt|private|plc|sa|ag|bv))+$/, '')
    .trim();
}
export function ensureCompany(ctx: Ctx, name: string): Id {
  if (ctx.actor.kind === 'system') throw new AppError('forbidden', 'Company actor required');
  const norm = nameNorm(validate(z.string().trim().min(1), name));
  if (!norm) throw new AppError('invalid', 'Company name is empty');
  return ctx.db.tx(() => {
    const r = ctx.db.get<{ id: Id }>(
      'SELECT id FROM company WHERE name_norm=? UNION ALL SELECT company_id AS id FROM company_alias WHERE alias_norm=? LIMIT 1',
      norm,
      norm,
    );
    if (r) return r.id;
    const id = ctx.db.run(
      'INSERT INTO company(name,name_norm,created_by_kind,created_at) VALUES (?,?,?,?)',
      name,
      norm,
      ctx.actor.kind,
      ctx.now().toISOString(),
    ).lastInsertRowid;
    record(ctx, { action: 'company.create', subjectKind: 'company', subjectId: id, after: { name } });
    return id;
  });
}
export function ensureIdentity(
  ctx: Ctx,
  p: { channel: string; userKey: string; displayName: string; handle: string | null },
): { identityId: Id; contactId: Id | null; teammateId: Id | null } {
  validate(z.strictObject({ channel: z.string().regex(/^[a-z][a-z0-9_]*$/), ...ParticipantRefSchema.shape }), p);
  return ctx.db.tx(() => {
    const existing = ctx.db.get<{
      id: Id;
      contact_id: Id | null;
      teammate_id: Id | null;
      display_name: string;
      handle: string | null;
    }>('SELECT * FROM identity WHERE channel=? AND user_key=?', p.channel, p.userKey);
    if (existing) {
      if (existing.display_name !== p.displayName || existing.handle !== p.handle) {
        ctx.db.run('UPDATE identity SET display_name=?,handle=? WHERE id=?', p.displayName, p.handle, existing.id);
        record(ctx, {
          action: 'contact.update',
          subjectKind: 'contact',
          subjectId: existing.contact_id,
          before: { identityId: existing.id },
          after: { identityId: existing.id, displayName: p.displayName, handle: p.handle },
        });
      }
      return { identityId: existing.id, contactId: existing.contact_id, teammateId: existing.teammate_id };
    }
    const contactId = ctx.db.run(
      'INSERT INTO contact(display_name,created_at) VALUES (?,?)',
      p.displayName,
      ctx.now().toISOString(),
    ).lastInsertRowid;
    const identityId = ctx.db.run(
      'INSERT INTO identity(channel,user_key,display_name,handle,contact_id) VALUES (?,?,?,?,?)',
      p.channel,
      p.userKey,
      p.displayName,
      p.handle,
      contactId,
    ).lastInsertRowid;
    record(ctx, {
      action: 'contact.update',
      subjectKind: 'contact',
      subjectId: contactId,
      after: { identityId, displayName: p.displayName },
    });
    return { identityId, contactId, teammateId: null };
  });
}
export function bindSelfIdentity(
  ctx: Ctx,
  p: { channel: string; userKey: string; displayName: string; handle: string | null; teammateId: Id },
): Id {
  validate(
    z.strictObject({
      channel: z.string().regex(/^[a-z][a-z0-9_]*$/),
      ...ParticipantRefSchema.shape,
      teammateId: IdSchema,
    }),
    p,
  );
  return ctx.db.tx(() => {
    if (!ctx.db.get('SELECT id FROM teammate WHERE id=? AND removed_at IS NULL', p.teammateId))
      throw new AppError('not_found', 'Teammate not found');
    const r = ctx.db.get<{ id: Id; contact_id: Id | null; teammate_id: Id | null }>(
      'SELECT * FROM identity WHERE channel=? AND user_key=?',
      p.channel,
      p.userKey,
    );
    if (r?.contact_id !== null && r?.contact_id !== undefined)
      throw new AppError('invalid', 'not built: bindSelfIdentity');
    if (r) {
      if (r.teammate_id !== p.teammateId) throw new AppError('conflict', 'Identity belongs to another teammate');
      return r.id;
    }
    const id = ctx.db.run(
      'INSERT INTO identity(channel,user_key,display_name,handle,teammate_id) VALUES (?,?,?,?,?)',
      p.channel,
      p.userKey,
      p.displayName,
      p.handle,
      p.teammateId,
    ).lastInsertRowid;
    record(ctx, {
      action: 'account.connect',
      subjectKind: 'teammate',
      subjectId: p.teammateId,
      after: { identityId: id },
    });
    return id;
  });
}
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
        'SELECT m.id FROM message m JOIN chat_participant cp ON cp.chat_id=m.chat_id JOIN identity i ON i.id=cp.identity_id WHERE m.id=? AND i.contact_id=? AND m.deleted_at IS NULL',
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
    const companyId = 'id' in i.company ? i.company.id : ensureCompany(ctx, i.company.name);
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
export function getCompany(ctx: Ctx, companyId: Id): CompanyView {
  validate(IdSchema, companyId);
  const company = ctx.db.get<{ id: Id; name: string }>('SELECT id,name FROM company WHERE id=?', companyId);
  if (!company) throw new AppError('not_found', 'Company not found');
  const refs = ctx.db.all(
    'SELECT id FROM company_reference WHERE removed=0 AND (from_company_id=? OR to_company_id=?)',
    companyId,
    companyId,
  );
  if (refs.length) throw new AppError('invalid', 'not built: getCompany');
  const contacts = ctx.db
    .all<{ id: Id; name: string; role_category: string; deals_about: string }>(
      'SELECT c.id,c.display_name AS name,c.role_category,c.deals_about FROM contact c JOIN contact_company cc ON cc.contact_id=c.id WHERE cc.company_id=? AND cc.removed=0 ORDER BY c.id',
      companyId,
    )
    .map(
      (c): ContactSummary => ({
        id: c.id,
        name: c.name,
        roleCategory: c.role_category,
        dealsAbout: c.deals_about,
        companies: ctx.db.all(
          'SELECT co.id,co.name FROM company co JOIN contact_company cc ON cc.company_id=co.id WHERE cc.contact_id=? AND cc.removed=0 ORDER BY co.id',
          c.id,
        ),
      }),
    );
  const chats = ctx.db
    .all<{ id: Id; title: string; lastMessageAt: string | null }>(
      'SELECT DISTINCT ch.id,ch.title,(SELECT max(sent_at) FROM message WHERE chat_id=ch.id) AS lastMessageAt FROM chat ch JOIN chat_participant cp ON cp.chat_id=ch.id JOIN identity i ON i.id=cp.identity_id JOIN contact_company cc ON cc.contact_id=i.contact_id WHERE cc.company_id=? AND cc.removed=0 ORDER BY ch.id',
      companyId,
    )
    .map((c) => ({
      ...c,
      teammates: ctx.db.all<{ id: Id; name: string }>(
        'SELECT DISTINCT t.id,t.display_name AS name FROM account_chat ac JOIN channel_account a ON a.id=ac.account_id JOIN teammate t ON t.id=a.teammate_id WHERE ac.chat_id=? ORDER BY t.id',
        c.id,
      ),
    }));
  const recentMessages = getMessages(ctx, { companyId, limit: 50 });
  return {
    ...company,
    aliases: ctx.db
      .all<{ alias: string }>('SELECT alias FROM company_alias WHERE company_id=? ORDER BY alias', companyId)
      .map((r) => r.alias),
    contacts,
    chats,
    lastConversationAt:
      chats
        .map((c) => c.lastMessageAt)
        .filter((t): t is string => t !== null)
        .sort()
        .at(-1) ?? null,
    recentMessages,
    cards: getBoard(ctx)
      .lanes.flatMap((l) => l.cards)
      .filter((c) => c.company?.id === companyId),
    referencesOut: [],
    referencedBy: [],
  };
}
