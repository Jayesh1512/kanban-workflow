import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/shared/ports.js';
import { RecordsRepository } from '../../src/workflow/records.js';
import { SqlAnalysisQueue, inputHash } from '../../src/workflow/analysis.js';
import { decisionFixture, extractionFixture, provenance } from '../intelligence/fixtures.js';
import { fixtureDatabase } from './database.js';

let db: Database; let records: RecordsRepository;
beforeEach(async () => { db = await fixtureDatabase(); records = new RecordsRepository(db, { now: () => new Date('2026-10-19T00:00:00Z') }); });
afterEach(async () => { await db?.close(); });
const companyWrite = { idempotencyKey: 'company1', canonicalName: 'Cedar Labs', aliases: ['Cedar'], domains: ['cedar.example.invalid'], buyerIds: ['buyer_demo'], providerIds: [], workstream: 'Buyer' as const, summary: 'Synthetic directory', evidenceIds: [] };
async function resolvedTicket() {
  const queue = new SqlAnalysisQueue(db, { now: () => new Date('2026-10-17T00:00:00Z') }); const job = (await queue.claim({ workerId: 'worker', leaseMs: 60000 }))!;
  const input = await queue.loadInput(job.id); const extraction = extractionFixture(input.evidence[0]!.id);
  await queue.saveExtraction({ jobId: job.id, extraction, inputHash: inputHash(input), provenance: provenance() }, job.claimToken);
  await queue.complete(job.id, decisionFixture(input.evidence[0]!.id), provenance('vercel'), job.claimToken);
  return { ticket: (await records.listTickets({})).items[0]!, evidence: input.evidence[0]!.id };
}

describe('records, contact roles, manual precedence and priorities (isolated PostgreSQL)', () => {
  it('uses durable same-key results, detects changed input and versions, and paginates deterministically', async () => {
    const created = await records.createCompany(companyWrite); expect(await records.createCompany(companyWrite)).toEqual(created);
    await expect(records.createCompany({ ...companyWrite, canonicalName: 'Changed' })).rejects.toThrow('different input');
    const updated = await records.updateCompany(created.id, 0, { ...companyWrite, idempotencyKey: 'update', aliases: ['Cedar', 'CDR'] }); expect(updated.version).toBe(1);
    await expect(records.updateCompany(created.id, 0, { ...companyWrite, idempotencyKey: 'oldversion' })).rejects.toThrow('version');
    await records.createCompany({ ...companyWrite, idempotencyKey: 'company2', canonicalName: 'Maple' });
    const first = await records.listCompanies({ limit: 1 }); const second = await records.listCompanies({ limit: 1, cursor: first.nextCursor! }); expect(first.items[0]!.id).not.toBe(second.items[0]!.id);
    expect((await records.listCompanies({ query: 'CDR' })).items).toHaveLength(1); await expect(records.listCompanies({ cursor: 'broken' })).rejects.toThrow('cursor');
  });
  it('does not create tickets for unresolved, excluded or control chats; same confirmed chat stays one ticket', async () => {
    await expect(records.ensureTicket('-1001')).rejects.toThrow('confirmed'); const c = await records.createCompany(companyWrite);
    await db.query("UPDATE chats SET company_id=$1,mapping_status='confirmed'", [c.id]); const first = await records.ensureTicket('-1001'); expect(first.lane).toBe('To be started'); expect((await records.ensureTicket('-1001')).id).toBe(first.id);
    await db.query("UPDATE chats SET inclusion='excluded',is_control=true"); await expect(records.ensureTicket('-1001')).rejects.toThrow('included'); await expect(records.getContext({ ticketId: first.id, limit: 50 })).rejects.toThrow('not tracked');
  });
  it('creates roles without preallocated contact ID, reads them back, and refuses Telegram identity collisions', async () => {
    const { ticket, evidence } = await resolvedTicket(); const existing = (await records.listContacts({ companyId: ticket.companyId })).items[0]!;
    expect(existing.roles).toMatchObject([{ companyId: ticket.companyId, contactId: existing.id, role: 'CTO' }]);
    await expect(records.createContact({ idempotencyKey: 'collision', names: ['Different Mira'], usernames: [], phones: [], emails: [], affiliation: 'unknown', evidenceIds: [], roles: [], telegramUserIds: ['7'] })).rejects.toThrow('assigned to another contact');
    const updated = await records.updateContact(existing.id, existing.version, { idempotencyKey: 'role-update', telegramUserIds: existing.telegramUserIds, names: existing.names, usernames: existing.usernames, phones: [], emails: [], affiliation: 'external', evidenceIds: [evidence], roles: [{ companyId: ticket.companyId, role: 'CTO', evidenceIds: [evidence] }] });
    expect((await records.getContact(updated.id)).roles[0]!.evidenceIds).toEqual([evidence]);
  });
  it('preserves manual action dates and actor/fact lifecycle through re-analysis', async () => {
    const { ticket, evidence } = await resolvedTicket();
    const manual = await records.updateActions({ idempotencyKey: 'manual', ticketId: ticket.id, expectedActionsVersion: ticket.actionsVersion, nextAction: 'Manual follow-up', followUpAt: '2026-10-20T04:00:00Z', etaAt: null, evidenceIds: [evidence] });
    expect(await records.updateActions({ idempotencyKey: 'manual', ticketId: ticket.id, expectedActionsVersion: ticket.actionsVersion, nextAction: 'Manual follow-up', followUpAt: '2026-10-20T04:00:00Z', etaAt: null, evidenceIds: [evidence] })).toEqual(manual);
    const fact = (await records.listFacts({ ticketId: ticket.id })).items[0]!;
    const updated = await records.updateFact({ idempotencyKey: 'fact-complete', factId: fact.id, expectedVersion: fact.version, state: 'completed', actor: fact.actor, dates: fact.dates, evidenceIds: fact.evidenceIds, answersFactId: null }); expect(updated.source).toBe('manual');
    const queue = new SqlAnalysisQueue(db); await db.query(`INSERT INTO analysis_jobs(chat_id,policy_version,mapping_version,dedupe_key) SELECT id,policy_version,mapping_version,'next' FROM chats`);
    const newId = (await db.query<{ id: string }>("SELECT id FROM analysis_jobs WHERE dedupe_key='next'")).rows[0]!.id;
    await db.query('INSERT INTO analysis_job_messages SELECT $1,chat_id,id,version FROM messages', [newId]); const claimed = (await queue.claim({ workerId: 'worker', leaseMs: 60000 }))!; const input = await queue.loadInput(claimed.id); const extraction = extractionFixture(input.evidence[0]!.id);
    await queue.saveExtraction({ jobId: claimed.id, extraction, inputHash: inputHash(input), provenance: provenance() }, claimed.claimToken);
    const decision = decisionFixture(input.evidence[0]!.id); decision.companyMatch = { outcome: 'matched', companyId: ticket.companyId, confidence: 1 };
    await queue.complete(claimed.id, decision, provenance('vercel'), claimed.claimToken);
    expect(await records.getTicket(ticket.id)).toMatchObject({ nextAction: 'Manual follow-up', followUpAt: '2026-10-20T04:00:00.000Z', actionsSource: 'manual' });
    expect((await records.listFacts({ ticketId: ticket.id })).items.find((f) => f.id === fact.id)).toMatchObject({ state: 'completed', source: 'manual' });
    await expect(records.updateFact({ idempotencyKey: 'old', factId: fact.id, expectedVersion: fact.version, state: 'open', actor: fact.actor, dates: fact.dates, evidenceIds: fact.evidenceIds, answersFactId: null })).rejects.toThrow('version');
  });
  it('ranks overdue AntSeed commitments using date-only precision and excludes completed/external/excluded work', async () => {
    const { ticket } = await resolvedTicket(); const priorities = await records.priorities({ date: '2026-10-19', timezone: 'Asia/Kolkata', limit: 20 });
    expect(priorities[0]).toMatchObject({ ticket: { id: ticket.id }, reasons: ['commitment', 'overdue'], urgency: 'urgent' });
    await db.query("UPDATE facts SET actor_party='external' WHERE parent_fact_id IS NULL"); expect(await records.priorities({ limit: 20 })).toEqual([]);
    await db.query("UPDATE facts SET actor_party='antseed',state='completed' WHERE parent_fact_id IS NULL"); expect(await records.priorities({ limit: 20 })).toEqual([]);
    await db.query("UPDATE facts SET state='open'"); await db.query("UPDATE tickets SET lane='Archived'"); expect(await records.priorities({ limit: 20 })).toEqual([]);
    await db.query("UPDATE tickets SET lane='To be started'"); await db.query("UPDATE chats SET inclusion='excluded'"); expect(await records.priorities({ limit: 20 })).toEqual([]);
  });
  it('filters invalidated evidence/facts and refuses updates based on stale evidence', async () => {
    const { ticket, evidence } = await resolvedTicket(); await db.query('UPDATE messages SET version=version+1');
    expect((await records.listFacts({ ticketId: ticket.id })).items).toEqual([]);
    await expect(records.getEvidence([evidence])).rejects.toThrow('Evidence'); await expect(records.createCompany({ ...companyWrite, evidenceIds: [evidence] })).rejects.toThrow('Evidence');
  });
});
