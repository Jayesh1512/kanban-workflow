import { z } from 'zod';
import type { BusinessFact, ContactDetail, DateFact, Page, Priority, Ticket } from '../shared/domain.js';
import type { Clock, CompanyWrite, ContactWrite, Database, RecordsService, SqlExecutor } from '../shared/ports.js';
import { updateActionsSchema, updateFactSchema, uuidSchema, workstreamSchema } from '../shared/schemas.js';
import { addDays, localDay } from '../intelligence/validation.js';
import { assert, assertEvidence, chatRow, command, companyRow, evidenceFor, evidenceRow, iso, links, messageRow, nullableIso, page, ticketRow, type Row } from './sql.js';

const companyInput = z.strictObject({ idempotencyKey: z.string().min(1).max(200), canonicalName: z.string().trim().min(1).max(500), aliases: z.array(z.string()), domains: z.array(z.string()),
  workstream: workstreamSchema.nullable(), summary: z.string().max(16000), buyerIds: z.array(z.string()), providerIds: z.array(z.string()), evidenceIds: z.array(uuidSchema) });
const contactInput = z.strictObject({ idempotencyKey: z.string().min(1).max(200), telegramUserIds: z.array(z.string().regex(/^[1-9]\d*$/)), names: z.array(z.string()), usernames: z.array(z.string()), phones: z.array(z.string()), emails: z.array(z.string()),
  affiliation: z.enum(['internal', 'external', 'unknown']), evidenceIds: z.array(uuidSchema), roles: z.array(z.strictObject({ companyId: uuidSchema, role: z.string().trim().min(1), evidenceIds: z.array(uuidSchema).min(1) })) });

export async function getCompanyTx(tx: SqlExecutor, id: string) {
  const r = (await tx.query('SELECT * FROM companies WHERE id=$1', [id])).rows[0]; assert(r, 'not_found', 'Company not found'); return companyRow(tx, r);
}
export async function getTicketTx(tx: SqlExecutor, id: string): Promise<Ticket> {
  const r = (await tx.query('SELECT * FROM tickets WHERE id=$1', [id])).rows[0]; assert(r, 'not_found', 'Ticket not found'); return ticketRow(tx, r);
}
export async function getContactTx(tx: SqlExecutor, id: string): Promise<ContactDetail> {
  const r = (await tx.query('SELECT * FROM contacts WHERE id=$1', [id])).rows[0]; assert(r, 'not_found', 'Contact not found');
  const roles = (await tx.query('SELECT * FROM contact_company_roles WHERE contact_id=$1 ORDER BY company_id,role', [id])).rows;
  return { id, names: r.names, usernames: r.usernames, phones: r.phones, emails: r.emails, affiliation: r.affiliation, version: Number(r.version),
    telegramUserIds: (await tx.query<{ telegram_user_id: string }>('SELECT telegram_user_id::text FROM contact_telegram_ids WHERE contact_id=$1 ORDER BY telegram_user_id', [id])).rows.map((r) => r.telegram_user_id),
    evidenceIds: await evidenceFor(tx, 'contact_evidence', 'contact_id', id),
    roles: await Promise.all(roles.map(async (role) => ({ contactId: id, companyId: String(role.company_id), role: String(role.role), evidenceIds: await evidenceFor(tx, 'role_evidence', 'role_id', String(role.id)) }))) };
}
export async function ensureTicketTx(tx: SqlExecutor, chatId: string): Promise<Ticket> {
  const r = (await tx.query('SELECT * FROM chats WHERE id=$1 FOR UPDATE', [chatId])).rows[0]; assert(r, 'not_found', 'Chat not found');
  assert(r.inclusion === 'included' && !r.is_control, 'excluded_chat', 'Chat is not included business content');
  assert(r.mapping_status === 'confirmed' && r.company_id, 'ambiguous_mapping', 'Chat has no confirmed company');
  const company = await getCompanyTx(tx, String(r.company_id));
  const ticket = (await tx.query(`INSERT INTO tickets(chat_id,company_id,workstream) VALUES($1,$2,$3)
    ON CONFLICT(chat_id) DO UPDATE SET company_id=EXCLUDED.company_id,tracking_state='active',updated_at=now() RETURNING *`, [chatId, r.company_id, company.workstream ?? 'Others'])).rows[0]!;
  return ticketRow(tx, ticket);
}
export async function writeCompanyTx(tx: SqlExecutor, input: CompanyWrite, id?: string, expectedVersion?: number) {
  await assertEvidence(tx, input.evidenceIds);
  let row: Row | undefined;
  const values = [input.canonicalName, [...new Set(input.aliases)], [...new Set(input.domains.map((d) => d.toLowerCase()))], input.workstream, input.summary, [...new Set(input.buyerIds)], [...new Set(input.providerIds)]];
  if (!id) row = (await tx.query('INSERT INTO companies(canonical_name,aliases,domains,workstream,summary,buyer_ids,provider_ids) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', values)).rows[0];
  else row = (await tx.query(`UPDATE companies SET canonical_name=$1,aliases=$2,domains=$3,workstream=$4,summary=$5,buyer_ids=$6,provider_ids=$7,version=version+1,updated_at=now()
    WHERE id=$8 AND version=$9 RETURNING *`, [...values, id, expectedVersion])).rows[0];
  assert(row, 'conflict', 'Company version changed or company not found');
  await links(tx, 'company_evidence', 'company_id', String(row.id), input.evidenceIds);
  return companyRow(tx, row);
}
export async function writeContactTx(tx: SqlExecutor, input: ContactWrite, id?: string, expectedVersion?: number) {
  await assertEvidence(tx, [...input.evidenceIds, ...input.roles.flatMap((r) => r.evidenceIds)]);
  const values = [[...new Set(input.names)], [...new Set(input.usernames)], [...new Set(input.phones)], [...new Set(input.emails)], input.affiliation];
  const row = !id ? (await tx.query('INSERT INTO contacts(names,usernames,phones,emails,affiliation) VALUES($1,$2,$3,$4,$5) RETURNING id', values)).rows[0]
    : (await tx.query('UPDATE contacts SET names=$1,usernames=$2,phones=$3,emails=$4,affiliation=$5,version=version+1,updated_at=now() WHERE id=$6 AND version=$7 RETURNING id', [...values, id, expectedVersion])).rows[0];
  assert(row, 'conflict', 'Contact version changed or contact not found'); const contactId = String(row.id);
  if (input.telegramUserIds.length) {
    const existing = await tx.query<{ contact_id: string }>('SELECT contact_id FROM contact_telegram_ids WHERE telegram_user_id=ANY($1::bigint[])', [input.telegramUserIds]);
    assert(existing.rows.every((r) => r.contact_id === contactId), 'conflict', 'Telegram identity is assigned to another contact');
  }
  await tx.query('DELETE FROM contact_telegram_ids WHERE contact_id=$1', [contactId]);
  for (const user of [...new Set(input.telegramUserIds)].sort()) await tx.query('INSERT INTO contact_telegram_ids(telegram_user_id,contact_id) VALUES($1,$2)', [user, contactId]);
  await links(tx, 'contact_evidence', 'contact_id', contactId, input.evidenceIds);
  await tx.query('DELETE FROM role_evidence WHERE role_id IN (SELECT id FROM contact_company_roles WHERE contact_id=$1)', [contactId]);
  await tx.query('DELETE FROM contact_company_roles WHERE contact_id=$1', [contactId]);
  for (const role of input.roles) {
    const roleId = (await tx.query<{ id: string }>('INSERT INTO contact_company_roles(contact_id,company_id,role) VALUES($1,$2,$3) ON CONFLICT(contact_id,company_id,role) DO UPDATE SET role=EXCLUDED.role RETURNING id', [contactId, role.companyId, role.role])).rows[0]!.id;
    await links(tx, 'role_evidence', 'role_id', roleId, role.evidenceIds, false);
  }
  return getContactTx(tx, contactId);
}

export async function factRow(tx: SqlExecutor, r: Row): Promise<BusinessFact> {
  const children = (await tx.query('SELECT facts.*,local_date::text AS local_date FROM facts WHERE parent_fact_id=$1 ORDER BY id', [r.id])).rows;
  const dates: DateFact[] = await Promise.all(children.map(async (d) => ({ kind: d.kind as DateFact['kind'], originalText: String(d.text), relativeTo: iso(d.relative_to), timezone: String(d.timezone),
    resolvedAt: nullableIso(d.resolved_at), localDate: d.local_date == null ? null : String(d.local_date),
    precision: d.date_precision as DateFact['precision'], ambiguous: Boolean(d.ambiguous), evidenceIds: await evidenceFor(tx, 'fact_evidence', 'fact_id', String(d.id)) })));
  return { id: String(r.id), kind: r.kind as BusinessFact['kind'], text: String(r.text), actor: { party: r.actor_party as BusinessFact['actor']['party'], contactId: r.actor_contact_id as string | null, displayName: r.actor_display_name as string | null },
    state: r.state as BusinessFact['state'], answersFactId: r.answers_fact_id as string | null, dates, evidenceIds: await evidenceFor(tx, 'fact_evidence', 'fact_id', String(r.id)), version: Number(r.version), source: r.source as BusinessFact['source'] };
}
export async function replaceDates(tx: SqlExecutor, parentId: string, jobId: string, ticketId: string | null, dates: DateFact[], source: 'manual' | 'inferred') {
  await tx.query('DELETE FROM fact_evidence WHERE fact_id IN (SELECT id FROM facts WHERE parent_fact_id=$1)', [parentId]);
  await tx.query('DELETE FROM facts WHERE parent_fact_id=$1', [parentId]);
  for (const d of dates) {
    const row = (await tx.query<{ id: string }>(`INSERT INTO facts(job_id,ticket_id,kind,text,relative_to,timezone,resolved_at,local_date,date_precision,ambiguous,parent_fact_id,source)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, [jobId, ticketId, d.kind, d.originalText, d.relativeTo, d.timezone, d.resolvedAt, d.localDate, d.precision, d.ambiguous, parentId, source])).rows[0]!;
    await links(tx, 'fact_evidence', 'fact_id', row.id, d.evidenceIds);
  }
}

export async function refreshInferredActions(tx: SqlExecutor, ticketId: string): Promise<void> {
  const facts = (await tx.query(`SELECT f.* FROM facts f WHERE f.ticket_id=$1 AND f.parent_fact_id IS NULL AND f.state='open'
    AND (f.source='manual' OR EXISTS(SELECT 1 FROM fact_evidence fe JOIN evidence e ON e.id=fe.evidence_id JOIN messages m ON m.chat_id=e.chat_id AND m.id=e.message_id
      JOIN chats c ON c.id=e.chat_id WHERE fe.fact_id=f.id AND e.invalidated_at IS NULL AND m.version=e.message_version AND m.deleted_at IS NULL AND c.inclusion='included' AND NOT c.is_control))
    ORDER BY f.created_at DESC,f.id`, [ticketId])).rows;
  const next = facts.find((f) => f.actor_party === 'antseed' && (f.kind === 'action' || f.kind === 'commitment'))?.text ?? null;
  await tx.query(`UPDATE tickets SET next_action=CASE WHEN actions_source='inferred' THEN $2 ELSE next_action END,
    actions_version=actions_version+CASE WHEN actions_source='inferred' AND next_action IS DISTINCT FROM $2::text THEN 1 ELSE 0 END,
    blockers=$3,updated_at=now() WHERE id=$1`, [ticketId, next, facts.filter((f) => f.kind === 'blocker').map((f) => f.text)]);
}

export class RecordsRepository implements RecordsService {
  constructor(readonly db: Database, private clock: Clock = { now: () => new Date() }, private timezone = 'Asia/Kolkata') {}
  async getCompany(id: string) { uuidSchema.parse(id); return getCompanyTx(this.db, id); }
  async createCompany(raw: CompanyWrite) { const input = companyInput.parse(raw); return command(this.db, 'company:create', input.idempotencyKey, input, (tx) => writeCompanyTx(tx, input)); }
  async updateCompany(id: string, expectedVersion: number, raw: CompanyWrite) { uuidSchema.parse(id); const input = companyInput.parse(raw); return command(this.db, `company:${id}`, input.idempotencyKey, { id, expectedVersion, input }, (tx) => writeCompanyTx(tx, input, id, expectedVersion)); }
  async listCompanies(input: Parameters<RecordsService['listCompanies']>[0]) {
    const p = page(input); const rows = (await this.db.query(`SELECT * FROM companies WHERE ($1::uuid IS NULL OR id>$1) AND ($2::text IS NULL OR canonical_name ILIKE $2 OR array_to_string(aliases,' ') ILIKE $2 OR array_to_string(domains,' ') ILIKE $2) ORDER BY id LIMIT $3`, [p.after, input.query ? `%${input.query.slice(0, 500)}%` : null, p.limit + 1])).rows;
    return { items: await Promise.all(rows.slice(0, p.limit).map((r) => companyRow(this.db, r))), nextCursor: rows.length > p.limit ? String(rows[p.limit - 1]!.id) : null };
  }
  async getContact(id: string) { uuidSchema.parse(id); return getContactTx(this.db, id); }
  async createContact(raw: ContactWrite) { const input = contactInput.parse(raw); return command(this.db, 'contact:create', input.idempotencyKey, input, (tx) => writeContactTx(tx, input)); }
  async updateContact(id: string, expectedVersion: number, raw: ContactWrite) { uuidSchema.parse(id); const input = contactInput.parse(raw); return command(this.db, `contact:${id}`, input.idempotencyKey, { id, expectedVersion, input }, (tx) => writeContactTx(tx, input, id, expectedVersion)); }
  async listContacts(input: Parameters<RecordsService['listContacts']>[0]) {
    const p = page(input); const rows = (await this.db.query<{ id: string }>(`SELECT c.id FROM contacts c WHERE ($1::uuid IS NULL OR c.id>$1) AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM contact_company_roles r WHERE r.contact_id=c.id AND r.company_id=$2)) ORDER BY c.id LIMIT $3`, [p.after, input.companyId ?? null, p.limit + 1])).rows;
    return { items: await Promise.all(rows.slice(0, p.limit).map((r) => getContactTx(this.db, r.id))), nextCursor: rows.length > p.limit ? rows[p.limit - 1]!.id : null };
  }
  async getTicket(id: string) { uuidSchema.parse(id); return getTicketTx(this.db, id); }
  async ensureTicket(chatId: string) { return this.db.transaction((tx) => ensureTicketTx(tx, chatId)); }
  async listTickets(input: Parameters<RecordsService['listTickets']>[0]) {
    const p = page(input); const rows = (await this.db.query(`SELECT * FROM tickets WHERE ($1::uuid IS NULL OR id>$1) AND ($2::uuid IS NULL OR company_id=$2) AND ($3::text IS NULL OR lane=$3) ORDER BY id LIMIT $4`, [p.after, input.companyId ?? null, input.lane ?? null, p.limit + 1])).rows;
    return { items: await Promise.all(rows.slice(0, p.limit).map((r) => ticketRow(this.db, r))), nextCursor: rows.length > p.limit ? String(rows[p.limit - 1]!.id) : null };
  }
  async getEvidence(ids: string[]) {
    assert(ids.length <= 200, 'validation', 'Too many evidence IDs'); ids.forEach((id) => uuidSchema.parse(id)); await assertEvidence(this.db, ids);
    return (await this.db.query('SELECT * FROM evidence WHERE id=ANY($1::uuid[]) ORDER BY observed_at,id', [ids])).rows.map(evidenceRow);
  }
  async listFacts(input: Parameters<RecordsService['listFacts']>[0]): Promise<Page<BusinessFact>> {
    const p = page(input); const rows = (await this.db.query(`SELECT f.* FROM facts f JOIN tickets t ON t.id=f.ticket_id JOIN chats c ON c.id=t.chat_id
      WHERE f.ticket_id=$1 AND f.parent_fact_id IS NULL AND c.inclusion='included' AND NOT c.is_control AND t.tracking_state='active'
      AND ($2::uuid IS NULL OR f.id>$2) ORDER BY f.id LIMIT $3`, [input.ticketId, p.after, p.limit + 1])).rows;
    const facts = await Promise.all(rows.slice(0, p.limit).map((r) => factRow(this.db, r)));
    return { items: facts.filter((f) => f.source === 'manual' || f.evidenceIds.length > 0), nextCursor: rows.length > p.limit ? String(rows[p.limit - 1]!.id) : null };
  }
  async getContext(input: { ticketId: string; limit: number }) {
    assert(Number.isInteger(input.limit) && input.limit > 0 && input.limit <= 200, 'validation', 'Invalid context limit');
    const ticket = await this.getTicket(input.ticketId); const row = (await this.db.query('SELECT * FROM chats WHERE id=$1', [ticket.chatId])).rows[0]!; const chat = chatRow(row);
    assert(chat.inclusion === 'included' && !chat.isControl && ticket.trackingState === 'active', 'excluded_chat', 'Ticket business context is not tracked');
    const messages = (await this.db.query('SELECT * FROM messages WHERE chat_id=$1 AND deleted_at IS NULL ORDER BY sent_at DESC,id DESC LIMIT $2', [chat.id, input.limit])).rows.map(messageRow);
    const evidence = (await this.db.query(`SELECT e.* FROM evidence e JOIN messages m ON m.chat_id=e.chat_id AND m.id=e.message_id
      WHERE e.chat_id=$1 AND e.message_id=ANY($2::int[]) AND e.message_version=m.version AND e.invalidated_at IS NULL AND m.deleted_at IS NULL ORDER BY e.observed_at DESC,e.id`, [chat.id, messages.map((m) => m.id)])).rows.map(evidenceRow);
    return { ticket, chat, company: await this.getCompany(ticket.companyId), contacts: await Promise.all(ticket.contactIds.map((id) => this.getContact(id))), evidence,
      messages, facts: (await this.listFacts({ ticketId: ticket.id, limit: input.limit })).items };
  }
  async updateActions(raw: Parameters<RecordsService['updateActions']>[0]) {
    const input = updateActionsSchema.parse(raw);
    return command(this.db, `actions:${input.ticketId}`, input.idempotencyKey, input, async (tx) => {
      await assertEvidence(tx, input.evidenceIds);
      const row = (await tx.query(`UPDATE tickets SET next_action=$1,follow_up_at=$2,eta_at=$3,actions_source='manual',actions_version=actions_version+1,updated_at=now()
        WHERE id=$4 AND actions_version=$5 RETURNING id`, [input.nextAction, input.followUpAt, input.etaAt, input.ticketId, input.expectedActionsVersion])).rows[0];
      assert(row, 'conflict', 'Ticket action version changed'); await links(tx, 'ticket_evidence', 'ticket_id', input.ticketId, input.evidenceIds, false); return getTicketTx(tx, input.ticketId);
    });
  }
  async updateFact(raw: Parameters<RecordsService['updateFact']>[0]) {
    const input = updateFactSchema.parse(raw);
    return command(this.db, `fact:${input.factId}`, input.idempotencyKey, input, async (tx) => {
      const ref = (await tx.query('SELECT j.chat_id FROM facts f JOIN analysis_jobs j ON j.id=f.job_id WHERE f.id=$1 AND f.parent_fact_id IS NULL', [input.factId])).rows[0];
      assert(ref, 'not_found', 'Fact not found');
      // Same order as ingestion/analysis: chat, then ticket, then fact. Read the
      // current ticket only AFTER the chat lock, since analysis may attach a
      // previously unassociated fact while this command waits for that lock.
      await tx.query('SELECT id FROM chats WHERE id=$1 FOR UPDATE', [ref.chat_id]);
      const current = (await tx.query('SELECT ticket_id FROM facts WHERE id=$1', [input.factId])).rows[0]!;
      if (current.ticket_id) await tx.query('SELECT id FROM tickets WHERE id=$1 FOR UPDATE', [current.ticket_id]);
      await assertEvidence(tx, [...input.evidenceIds, ...input.dates.flatMap((d) => d.evidenceIds)]);
      if (input.answersFactId) { const answered = (await tx.query('SELECT ticket_id FROM facts WHERE id=$1', [input.answersFactId])).rows[0]; const current = (await tx.query('SELECT ticket_id FROM facts WHERE id=$1', [input.factId])).rows[0]; assert(answered && current && answered.ticket_id === current.ticket_id && input.answersFactId !== input.factId, 'validation', 'Invalid answering fact'); }
      const row = (await tx.query(`UPDATE facts SET actor_party=$1,actor_contact_id=$2,actor_display_name=$3,state=$4,answers_fact_id=$5,source='manual',version=version+1
        WHERE id=$6 AND version=$7 AND parent_fact_id IS NULL RETURNING *`, [input.actor.party, input.actor.contactId, input.actor.displayName, input.state, input.answersFactId, input.factId, input.expectedVersion])).rows[0];
      assert(row, 'conflict', 'Fact version changed'); await links(tx, 'fact_evidence', 'fact_id', input.factId, input.evidenceIds);
      for (const date of input.dates) { new Intl.DateTimeFormat('en', { timeZone: date.timezone }); assert(!date.ambiguous || date.precision === 'unresolved', 'validation', 'Ambiguous date cannot have a resolved instant/day'); }
      await replaceDates(tx, input.factId, String(row.job_id), row.ticket_id as string | null, input.dates, 'manual');
      if (row.ticket_id) await refreshInferredActions(tx, String(row.ticket_id)); return factRow(tx, row);
    });
  }
  async priorities(input: Parameters<RecordsService['priorities']>[0]): Promise<Priority[]> {
    assert(Number.isInteger(input.limit) && input.limit > 0 && input.limit <= 200, 'validation', 'Invalid priorities limit');
    const timezone = input.timezone ?? this.timezone; const day = input.date ?? localDay(this.clock.now(), timezone); z.iso.date().parse(day); new Intl.DateTimeFormat('en', { timeZone: timezone });
    const rows = (await this.db.query(`SELECT t.* FROM tickets t JOIN chats c ON c.id=t.chat_id WHERE t.tracking_state='active' AND c.inclusion='included' AND NOT c.is_control AND t.lane NOT IN ('Archived','Completed') ORDER BY t.id LIMIT 5000`)).rows;
    const priorities: Priority[] = [];
    for (const row of rows) {
      const ticket = await ticketRow(this.db, row); const reasons = new Set<Priority['reasons'][number]>(); const evidence = new Set(ticket.evidenceIds);
      const facts = (await this.listFacts({ ticketId: ticket.id, limit: 200 })).items;
      const due = (date: string) => { if (date < day) reasons.add('overdue'); else if (date <= addDays(day, 7)) reasons.add('upcoming'); };
      if (ticket.followUpAt) due(localDay(ticket.followUpAt, timezone)); if (ticket.etaAt) due(localDay(ticket.etaAt, timezone));
      for (const fact of facts.filter((f) => f.state === 'open')) {
        if (fact.kind === 'commitment' && fact.actor.party === 'antseed') reasons.add('commitment');
        if (fact.kind === 'question') reasons.add('unanswered');
        if (fact.kind === 'blocker') reasons.add('blocked');
        if (fact.actor.party === 'antseed') for (const d of fact.dates) {
          if (!d.ambiguous && d.precision === 'date' && d.localDate) due(d.localDate);
          else if (!d.ambiguous && d.precision === 'instant' && d.resolvedAt) due(localDay(d.resolvedAt, timezone));
        }
        fact.evidenceIds.forEach((id) => evidence.add(id));
      }
      if (ticket.lane === 'Blocked') reasons.add('blocked');
      if (!reasons.size) continue;
      priorities.push({ ticket, reasons: [...reasons].sort(), evidenceIds: [...evidence].sort(), urgency: reasons.has('overdue') ? 'urgent' : reasons.has('blocked') ? 'high' : 'normal' });
    }
    const rank = { urgent: 0, high: 1, normal: 2, low: 3 };
    return priorities.sort((a, b) => rank[a.urgency] - rank[b.urgency] || a.ticket.id.localeCompare(b.ticket.id)).slice(0, input.limit);
  }
}
