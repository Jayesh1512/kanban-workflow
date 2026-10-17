import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnalysisJob, Database, ExtractionPort, JevPort } from '../../src/shared/ports.js';
import { SqlAnalysisQueue, inputHash } from '../../src/workflow/analysis.js';
import { RecordsRepository } from '../../src/workflow/records.js';
import { processAnalysisOnce } from '../../src/workflow/processor.js';
import { decisionFixture, extractionFixture, provenance } from '../intelligence/fixtures.js';
import { fixtureDatabase, seedJob } from './database.js';
import { readFile } from 'node:fs/promises';
import { OPENAI_DECISIONS_VERSION } from '../../src/intelligence/openai-decisions.js';
import { ProposalRepository } from '../../src/workflow/proposals.js';
import type { ControlBus } from '../../src/shared/ports.js';

let db: Database; let now: Date; let queue: SqlAnalysisQueue; let job: AnalysisJob;
beforeEach(async () => { db = await fixtureDatabase(); now = new Date('2026-10-17T00:00:00Z'); queue = new SqlAnalysisQueue(db, { now: () => now }); job = (await queue.claim({ workerId: 'worker', leaseMs: 60000 }))!; });
afterEach(async () => { await db?.close(); });
async function checkpoint() { const input = await queue.loadInput(job.id); const extraction = extractionFixture(input.evidence[0]!.id); return { jobId: job.id, inputHash: inputHash(input), extraction, provenance: provenance() }; }
const entitlement = { ok: false as const, code: 'entitlement' as const, retryable: false, retryAt: null, detail: 'Never persist synthetic-key or raw body' };

describe('durable analysis checkpoint and immutable lease fencing (isolated PGlite)', () => {
  it('retains native OpenAI decision provenance and creates an OpenAI pending-only proposal after the additive migration', async () => {
    const migration = await readFile(new URL('../../db/migrations/202610170002_decision_origins.sql', import.meta.url), 'utf8');
    for (const statement of migration.split(';').filter(s => s.trim())) await db.query(statement);
    const proposals = new ProposalRepository(db, {} as ControlBus, { now: () => now });
    queue = new SqlAnalysisQueue(db, { now: () => now }, 'Asia/Kolkata', { onDecision: (tx, input) => proposals.recordAnalysisDecisionTx(tx, input) });
    const value = await checkpoint(); await queue.saveExtraction(value, job.claimToken);
    const decision = decisionFixture(value.extraction.evidenceIds[0]); decision.model = 'gpt-6-luna'; decision.diagnostics.rubricVersion = OPENAI_DECISIONS_VERSION;
    decision.lane = { outcome: 'propose', targetLane: 'Work in progress', evidenceIds: value.extraction.evidenceIds, reason: 'Sourced engagement', nextAction: null };
    await queue.complete(job.id, decision, { ...provenance(), model: 'gpt-6-luna', schemaVersion: OPENAI_DECISIONS_VERSION }, job.claimToken);
    expect((await db.query('SELECT status,extraction_provenance,jev_provenance FROM analysis_jobs WHERE id=$1', [job.id])).rows[0]).toMatchObject({ status: 'completed', extraction_provenance: { provider: 'openai', model: 'gpt-6.1-sol' }, jev_provenance: { provider: 'openai', model: 'gpt-6-luna' } });
    expect((await db.query('SELECT origin,decision,apply_state FROM proposals')).rows).toEqual([{ origin: 'openai', decision: 'pending', apply_state: 'not_requested' }]);
    expect((await db.query('SELECT lane,stage_version FROM tickets')).rows).toEqual([{ lane: 'To be started', stage_version: 0 }]);
    expect((await db.query('SELECT id FROM mutations')).rows).toHaveLength(0);
  });
  it('saves extraction/facts before Jev 403 and reuses the checkpoint after explicit replay', async () => {
    const value = await checkpoint(); await queue.saveExtraction(value, job.claimToken); await queue.fail(job.id, entitlement, job.claimToken);
    expect((await db.query('SELECT status,last_error,decision,extraction FROM analysis_jobs')).rows[0]).toMatchObject({ status: 'provider_unavailable', last_error: 'provider_entitlement', decision: null, extraction: value.extraction });
    expect((await db.query('SELECT actor_party,state,local_date,resolved_at FROM facts ORDER BY parent_fact_id NULLS FIRST')).rows).toContainEqual({ actor_party: 'unknown', state: 'open', local_date: expect.anything(), resolved_at: null });
    expect((await queue.getExtraction(job.id))?.extraction).toEqual(value.extraction);
    expect(await queue.claim({ workerId: 'worker', leaseMs: 1000 })).toBeNull();
    expect(await queue.replayUnavailable({ idempotencyKey: 'replay' })).toEqual({ queued: 1 }); expect(await queue.replayUnavailable({ idempotencyKey: 'replay' })).toEqual({ queued: 1 });
    job = (await queue.claim({ workerId: 'worker', leaseMs: 60000 }))!;
    const restored = await queue.getExtraction(job.id); expect(restored).toEqual(value);
    await queue.complete(job.id, decisionFixture(value.extraction.evidenceIds[0]), provenance('vercel'), job.claimToken);
    expect((await db.query('SELECT status,jev_provenance FROM analysis_jobs')).rows[0]).toMatchObject({ status: 'completed', jev_provenance: { provider: 'vercel' } });
    const records = new RecordsRepository(db); const tickets = await records.listTickets({}); expect(tickets.items).toHaveLength(1);
    expect(tickets.items[0]).toMatchObject({ lane: 'To be started', stageVersion: 0, workstream: 'Buyer', nextAction: 'AntSeed will send notes tomorrow' });
    const context = await records.getContext({ ticketId: tickets.items[0]!.id, limit: 100 }); expect(context.contacts[0]!.roles[0]!.role).toBe('CTO'); expect(context.messages[0]!.sender.names).toEqual(['Mira']);
    expect(context.facts[0]!.dates[0]).toMatchObject({ localDate: '2026-10-18', resolvedAt: null, precision: 'date' });
    expect((await db.query('SELECT source FROM mapping_history')).rows).toEqual([{ source: 'analysis' }]); expect((await db.query('SELECT * FROM proposals')).rows).toHaveLength(0);
  });
  it('rejects old save/complete/fail after expiry and SAME-workerId reclaim without touching the new attempt', async () => {
    const old = job; const value = await checkpoint(); await queue.saveExtraction(value, old.claimToken);
    now = new Date(now.getTime() + 60001);
    await expect(queue.saveExtraction(value, old.claimToken)).rejects.toThrow('claim expired');
    job = (await queue.claim({ workerId: 'worker', leaseMs: 60000 }))!; expect(job.claimToken).not.toBe(old.claimToken);
    const newer = { ...value, extraction: { ...value.extraction, summary: 'New attempt extraction' } }; await queue.saveExtraction(newer, job.claimToken);
    await expect(queue.saveExtraction(value, old.claimToken)).rejects.toThrow('claim expired');
    await expect(queue.complete(job.id, decisionFixture(value.extraction.evidenceIds[0]), provenance('vercel'), old.claimToken)).rejects.toThrow('claim expired');
    await expect(queue.fail(job.id, entitlement, old.claimToken)).rejects.toThrow('claim expired');
    const row = (await db.query('SELECT worker_id,status,extraction,attempts,last_error FROM analysis_jobs')).rows[0]!;
    expect(row).toMatchObject({ worker_id: job.claimToken, status: 'running', extraction: newer.extraction, attempts: 2, last_error: null });
  });
  it.each(['policy', 'mapping', 'message', 'deletion', 'stage'])('fences changed %s before checkpoint or decision commit', async (kind) => {
    const value = await checkpoint(); await queue.saveExtraction(value, job.claimToken);
    if (kind === 'policy') await db.query("UPDATE chats SET inclusion='excluded',policy_version=policy_version+1");
    if (kind === 'mapping') await db.query('UPDATE chats SET mapping_version=mapping_version+1');
    if (kind === 'message') await db.query("UPDATE messages SET text='Changed',version=version+1");
    if (kind === 'deletion') await db.query('UPDATE messages SET deleted_at=now()');
    if (kind === 'stage') { await db.query("INSERT INTO companies(canonical_name) VALUES('Other')"); await db.query("INSERT INTO tickets(chat_id,company_id) SELECT -1001,id FROM companies"); }
    await expect(queue.saveExtraction(value, job.claimToken)).rejects.toThrow(); await expect(queue.complete(job.id, decisionFixture(value.extraction.evidenceIds[0]), provenance('vercel'), job.claimToken)).rejects.toThrow();
    expect((await db.query('SELECT decision FROM analysis_jobs')).rows[0]!.decision).toBeNull();
  });
  it('preserves an explicit human mapping correction and creates no duplicate company/ticket', async () => {
    const company = (await db.query<{ id: string }>("INSERT INTO companies(canonical_name) VALUES('Manual Company') RETURNING id")).rows[0]!.id;
    await db.query("UPDATE chats SET company_id=$1,mapping_status='confirmed' WHERE id=-1001", [company]);
    await db.query("INSERT INTO mapping_history(chat_id,company_id,mapping_status,version,reason,source) VALUES(-1001,$1,'confirmed',0,'Operator correction','http')", [company]);
    const value = await checkpoint(); await queue.saveExtraction(value, job.claimToken); await queue.complete(job.id, decisionFixture(value.extraction.evidenceIds[0]), provenance('vercel'), job.claimToken);
    expect((await db.query('SELECT canonical_name FROM companies')).rows).toEqual([{ canonical_name: 'Manual Company' }]); expect((await db.query('SELECT company_id FROM tickets')).rows).toEqual([{ company_id: company }]);
  });
  it('leaves ambiguous adjudication unresolved without ticket or incidental company creation', async () => {
    const value = await checkpoint(); await queue.saveExtraction(value, job.claimToken); const decision = decisionFixture(value.extraction.evidenceIds[0]);
    decision.companyMatch = { outcome: 'ambiguous', candidates: value.extraction.companyCandidates }; decision.diagnostics.answers.company_match = { type: 'choice', choice: 'ambiguous', confidence: 0.2, probabilities: { ambiguous: 0.6, new_company: 0.4 } };
    await queue.complete(job.id, decision, provenance('vercel'), job.claimToken);
    expect((await db.query('SELECT * FROM tickets')).rows).toHaveLength(0); expect((await db.query('SELECT * FROM companies')).rows).toHaveLength(0); expect((await db.query('SELECT * FROM mapping_candidates')).rows).toHaveLength(1);
  });
  it('resolves a supported existing company and stales prior work atomically', async () => {
    const company = (await db.query<{ id: string }>("INSERT INTO companies(canonical_name,aliases) VALUES('Cedar Labs',ARRAY['Cedar']) RETURNING id")).rows[0]!.id;
    const oldJob = '00000000-0000-4000-8000-000000000004'; await seedJob(db, oldJob);
    const value = await checkpoint(); await queue.saveExtraction(value, job.claimToken); const decision = decisionFixture(value.extraction.evidenceIds[0]);
    decision.companyMatch = { outcome: 'matched', companyId: company, confidence: 1 }; decision.diagnostics.answers.company_match = { type: 'choice', choice: 'existing_0', confidence: 1, probabilities: { existing_0: 1, none: 0, ambiguous: 0, new_company: 0 } };
    await queue.complete(job.id, decision, provenance('vercel'), job.claimToken);
    expect((await db.query('SELECT company_id,mapping_version FROM chats')).rows[0]).toMatchObject({ company_id: company, mapping_version: 1 });
    expect((await db.query('SELECT status FROM analysis_jobs WHERE id=$1', [oldJob])).rows[0]!.status).toBe('cancelled');
    expect((await db.query('SELECT status FROM analysis_jobs WHERE id=$1', [job.id])).rows[0]!.status).toBe('completed');
  });
  it('deduplicates the shared company/contact directory across two chats and keeps one ticket per chat', async () => {
    let value = await checkpoint(); await queue.saveExtraction(value, job.claimToken); await queue.complete(job.id, decisionFixture(value.extraction.evidenceIds[0]), provenance('vercel'), job.claimToken);
    await db.query("INSERT INTO chats(id,kind,title,inclusion) VALUES(-1002,'supergroup','Cedar Labs 2','included')");
    await db.query('INSERT INTO messages(chat_id,id,sender_id,sent_at,text,sender_snapshot,peer_snapshot,forward_metadata) SELECT -1002,id,sender_id,sent_at,text,sender_snapshot,peer_snapshot,forward_metadata FROM messages WHERE chat_id=-1001');
    await seedJob(db, '00000000-0000-4000-8000-000000000003', '-1002'); job = (await queue.claim({ workerId: 'worker', leaseMs: 60000 }))!;
    value = await checkpoint(); await queue.saveExtraction(value, job.claimToken); await queue.complete(job.id, decisionFixture(value.extraction.evidenceIds[0]), provenance('vercel'), job.claimToken);
    expect((await db.query('SELECT * FROM companies')).rows).toHaveLength(1); expect((await db.query('SELECT * FROM contacts')).rows).toHaveLength(1); expect((await db.query('SELECT * FROM tickets')).rows).toHaveLength(2);
  });
  it('processor reuses a current checkpoint without a second extraction request', async () => {
    const value = await checkpoint(); await queue.saveExtraction(value, job.claimToken); await queue.fail(job.id, entitlement, job.claimToken); await queue.replayUnavailable({ idempotencyKey: 'retry' });
    let extractionCalls = 0; let jevCalls = 0;
    const extractor: ExtractionPort = { status: async () => { throw new Error('unused'); }, extract: async () => { extractionCalls++; throw new Error('must not run'); } };
    const jev: JevPort = { status: async () => { throw new Error('unused'); }, decide: async () => { jevCalls++; return entitlement; } };
    expect(await processAnalysisOnce({ queue, extraction: extractor, jev }, { workerId: 'worker', leaseMs: 60000 })).toBe(true);
    expect(extractionCalls).toBe(0); expect(jevCalls).toBe(1); expect((await db.query('SELECT status FROM analysis_jobs')).rows[0]!.status).toBe('provider_unavailable');
  });
  it('always includes the explicit old source snapshot when recent context reaches the size bound', async () => {
    for (let id = 2; id <= 12; id++) await db.query("INSERT INTO messages(chat_id,id,sent_at,text) VALUES(-1001,$1,'2026-10-17T00:00:00Z',$2)", [id, 'x'.repeat(8000)]);
    const input = await queue.loadInput(job.id); expect(input.messages.some((m) => m.id === 1)).toBe(true);
    expect(input.messages.reduce((sum, m) => sum + m.text.length, 0)).toBeLessThanOrEqual(64000);
  });
});
