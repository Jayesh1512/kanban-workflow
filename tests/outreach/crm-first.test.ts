import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { OutreachWorkflow } from '../../src/outreach/service.js';
import { DurableControlBus } from '../../src/telegram/control.js';
import { TelegramStore } from '../../src/telegram/store.js';
import { RecordsRepository } from '../../src/workflow/records.js';
import { SqlAnalysisQueue, inputHash } from '../../src/workflow/analysis.js';
import { ProposalRepository } from '../../src/workflow/proposals.js';
import { observeRemoteTx } from '../../src/workflow/mutations.js';
import type { ControlBus, DomainServices, RuntimeConfig, TelegramPort } from '../../src/shared/ports.js';
import { registerTransports } from '../../src/hermes/module.js';
import { connectClient } from '../hermes/client.js';
import type { PgDatabase } from '../../src/platform/database.js';
import { fixtureDatabase } from '../workflow/database.js';
import { decisionFixture, extractionFixture, provenance } from '../intelligence/fixtures.js';
import { telegramFixture, fixtureMessage } from '../platform/telegram-fixture.js';

const migrationNames = ['202610250001_outreach_core.sql', '202610260001_outreach_workflow.sql',
  '202610260002_stable_outreach_sources.sql', '202610270004_operator_intake_approvals.sql', '202610280001_crm_first.sql'];
const migrations = migrationNames.map(name => new URL(`../../db/migrations/${name}`, import.meta.url));
const config: RuntimeConfig['jev'] = { provider: 'openai', endpoint: 'https://api.openai.com/v1/decisions', model: 'gpt-6-luna', apiKey: null, timeoutMs: 1000, maxAttempts: 1 };
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup() {
  const db = await fixtureDatabase(migrations); cleanup.push(() => db.close());
  // Single-engine transport test only; this seam makes no claim about real
  // PostgreSQL session-lock exclusion or concurrent workers.
  db.withSessionLock = async (_key, work) => work(db, new AbortController().signal);
  await db.query("INSERT INTO chats(id,kind,title,inclusion,is_control) VALUES(-999,'supergroup','Approvals','excluded',true)");
  await db.query("INSERT INTO evidence(chat_id,message_id,message_version,excerpt,observed_at) SELECT chat_id,id,version,text,sent_at FROM messages WHERE chat_id=-1001");
  const service = new OutreachWorkflow(db, { now: () => new Date() }, config);
  const store = new TelegramStore(db as PgDatabase, { apiId: null, apiHash: null, sessionPath: ':memory:', historyBatchSize: 2, historyMaxBatches: 2 });
  const sent: Array<{ chatId: string; text: string; randomId: string; id: number }> = [];
  const telegram = { status: async () => ({ state: 'ready' }), authorizedSelf: async () => '99',
    sendControlMessage: async (input: { chatId: string; text: string; randomId: string }) => {
      let row = sent.find(s => s.randomId === input.randomId);
      if (!row) { row = { ...input, id: sent.length + 100 }; sent.push(row); }
      return { messageId: row.id };
    }, getHistory: async () => ({ messages: sent.map(s => ({ ...fixtureMessage(s.id, s.chatId, s.text), senderId: '99' })), complete: true, next: null }),
  } as unknown as TelegramPort;
  const bus = new DurableControlBus(db as PgDatabase, telegram, store);
  const handlerErrors: unknown[] = [];
  bus.subscribeOwner('outreach', async m => { try { await service.handleControlReply(m); } catch (error) { handlerErrors.push(error); throw error; } }, id => service.isProposalCurrent(id));
  await service.reconcile();
  const relationship = (await service.list({})).items[0]!;
  async function reply(proposalId: unknown, text = 'approve', messageId = 700) {
    await bus.tick();
    const outbox = (await db.query('SELECT message_id FROM outreach_control_outbox WHERE proposal_id=$1', [proposalId])).rows[0]!;
    expect(outbox.message_id).not.toBeNull();
    await store.ingest({ type: 'message', message: { ...fixtureMessage(messageId, '-999', text), senderId: '99', replyToId: Number(outbox.message_id) } });
    await bus.tick();
    if (handlerErrors.length) throw handlerErrors.shift();
  }
  async function approveCrm() {
    const r = (await service.get(relationship.id)).relationship;
    const p = await service.propose({ relationshipId: r.id, expectedEvidenceRevision: r.evidenceRevision,
      idempotencyKey: 'initial-crm', targetStage: 'qualification', reason: 'Review current conversation' });
    await reply(p.id);
    return (await service.get(r.id)).relationship;
  }
  async function work(key = 'work-1', action = 'Prepare the integration test plan') {
    const r = (await service.get(relationship.id)).relationship;
    return service.proposeWork({ relationshipId: r.id, chatId: '-1001', expectedEvidenceRevision: r.evidenceRevision,
      idempotencyKey: key, action, reason: 'The CRM conversation requires this concrete deliverable' });
  }
  return { db, service, store, bus, sent, relationship, reply, approveCrm, work };
}

describe('CRM-first relationship and Telegram-approved Work flow (real local SQL, controlled Telegram)', () => {
  it('shares pending Work/data proposals across HTTP and MCP, with decisions accepted only through Telegram', async () => {
    const h = await setup(); await h.approveCrm();
    const records = new RecordsRepository(h.db);
    const app = Fastify();
    const transports = registerTransports(app, { outreach: h.service, records } as unknown as DomainServices, async () => {});
    app.addHook('preClose', () => transports.close());
    const url = await app.listen({ host: '127.0.0.1', port: 0 }); cleanup.push(() => app.close());
    const client = await connectClient(url); cleanup.push(() => client.close());
    expect((await app.inject('/api/meetings')).statusCode).toBe(404);
    const tools = (await client.listTools()).tools.map(t => t.name);
    expect(tools).toContain('propose_crm_work'); expect(tools.some(t => t.includes('meeting'))).toBe(false);
    const r = (await h.service.get(h.relationship.id)).relationship;
    const body = { chatId: '-1001', action: 'Prepare the integration test plan', reason: 'CRM requires this deliverable', expectedEvidenceRevision: r.evidenceRevision, idempotencyKey: 'transport-work' };
    const http = await app.inject({ method: 'POST', url: `/api/outreach/relationships/${r.id}/work`, payload: body });
    expect(http.statusCode).toBe(200);
    const p = http.json();
    const mcp = await client.callTool({ name: 'propose_crm_work', arguments: { ...body, relationshipId: r.id } });
    expect(mcp.isError).not.toBe(true); expect(mcp.structuredContent).toMatchObject({ id: p.id, state: 'pending' });
    expect((await records.listTickets({})).items).toEqual([]);
    expect((await app.inject({ method: 'POST', url: `/api/outreach/proposals/${p.id}/decision`, payload: { action: 'approve', idempotencyKey: 'http-bypass', reason: 'Bypass' } })).statusCode).toBe(409);
    await h.reply(p.id, 'approve', 701);
    const ticket = (await records.listTickets({})).items[0]!;
    expect(ticket).toMatchObject({ crmRelationshipId: r.id, creationProposalId: p.id, nextAction: body.action });
    const edit = { ticketId: ticket.id, nextAction: 'Deliver the reviewed test plan', expectedActionsVersion: 0, followUpAt: null, etaAt: null, evidenceIds: ticket.evidenceIds, idempotencyKey: 'transport-edit' };
    const pending = await app.inject({ method: 'PUT', url: `/api/tickets/${ticket.id}/actions`, payload: edit });
    expect(pending.statusCode).toBe(200); expect(pending.json()).toMatchObject({ command_kind: 'work_actions', state: 'pending' });
    expect((await records.getTicket(ticket.id)).nextAction).toBe(body.action);
    await h.reply(pending.json().id, 'approve', 702);
    expect((await records.getTicket(ticket.id)).nextAction).toBe(edit.nextAction);
  });

  it('builds a CRM relationship, contacts and evidence directly from a chat with zero Work tickets', async () => {
    const h = await setup();
    const queue = new SqlAnalysisQueue(h.db);
    const job = (await queue.claim({ workerId: 'crm', leaseMs: 120000 }))!;
    const input = await queue.loadInput(job.id);
    const extraction = extractionFixture(input.evidence[0]!.id);
    await queue.saveExtraction({ jobId: job.id, extraction, provenance: provenance(), inputHash: inputHash(input) }, job.claimToken);
    await queue.complete(job.id, decisionFixture(input.evidence[0]!.id), provenance('vercel'), job.claimToken);
    await h.service.reconcile();
    const detail = await h.service.get(h.relationship.id);
    expect(detail.pendingSources).toHaveLength(1);
    expect(detail.pendingSources[0]!.evidence.length).toBeGreaterThan(0);
    expect(detail.pendingSources[0]!.facts.length).toBeGreaterThan(0);
    expect(detail.pendingSources[0]!.contacts.length).toBeGreaterThan(0);
    expect((await h.db.query('SELECT * FROM tickets')).rows).toEqual([]);
    expect((await h.db.query('SELECT * FROM proposals')).rows).toEqual([]);
    expect(detail.relationship.kind).toBe('company');
  });

  it('requires approval of initial CRM placement and a separate concrete Work proposal', async () => {
    const h = await setup();
    await expect(h.work()).rejects.toThrow('Approve the CRM');
    await h.approveCrm();
    expect((await h.db.query('SELECT * FROM tickets')).rows).toEqual([]);
    const p = await h.work();
    expect((await h.db.query('SELECT * FROM tickets')).rows).toEqual([]);
    const outbox = (await h.db.query('SELECT text FROM outreach_control_outbox WHERE proposal_id=$1', [p.id])).rows[0]!;
    expect(outbox.text).toContain('CRM → Work ticket review');
    expect(outbox.text).toContain('Prepare the integration test plan');
    await h.reply(p.id, 'approve', 701);
    expect((await h.db.query('SELECT lane,next_action,crm_relationship_id,creation_proposal_id FROM tickets')).rows).toEqual([
      { lane: 'To be started', next_action: 'Prepare the integration test plan', crm_relationship_id: h.relationship.id, creation_proposal_id: p.id },
    ]);
    expect((await h.service.get(h.relationship.id)).relationship).toMatchObject({ acceptedStage: 'qualification', stageVersion: 1 });
    await h.reply(p.id, 'approve', 702);
    expect((await h.db.query('SELECT * FROM tickets')).rows).toHaveLength(1);
    expect((await h.db.query("SELECT * FROM outreach_sales_decisions WHERE proposal_id=$1", [p.id])).rows).toHaveLength(1);
  });

  it.each(['active', 'suspended'] as const)('learns CRM company identity with an existing %s Work action without creating more Work', async tracking => {
    const h = await setup(); await h.approveCrm(); const work = await h.work(); await h.reply(work.id, 'approve', 701);
    await h.db.query('UPDATE tickets SET tracking_state=$1', [tracking]);
    const queue = new SqlAnalysisQueue(h.db, { now: () => new Date() }, 'Asia/Kolkata', { onDecision: async () => { throw Error('Identity reconciliation must precede another Work recommendation'); } });
    const job = (await queue.claim({ workerId: 'crm-only', leaseMs: 120000 }))!;
    const input = await queue.loadInput(job.id);
    if (tracking === 'suspended') expect(input.ticket).toBeNull(); else expect(input.ticket).not.toBeNull();
    const extraction = extractionFixture(input.evidence[0]!.id);
    await queue.saveExtraction({ jobId: job.id, extraction, provenance: provenance(), inputHash: inputHash(input) }, job.claimToken);
    await queue.complete(job.id, decisionFixture(input.evidence[0]!.id), provenance('vercel'), job.claimToken);
    await h.service.reconcile();
    expect((await h.service.get(h.relationship.id)).relationship.kind).toBe('company');
    expect((await h.db.query('SELECT tracking_state,kind,company_id FROM tickets')).rows).toMatchObject([{ tracking_state: tracking, kind: 'company', company_id: expect.any(String) }]);
    expect((await h.db.query('SELECT id FROM tickets')).rows).toHaveLength(1);
  });

  it('supports multiple independently approved actions from one CRM conversation', async () => {
    const h = await setup(); await h.approveCrm();
    const first = await h.work(); await h.reply(first.id, 'approve', 701);
    await h.service.reconcile();
    const second = await h.work('work-2', 'Deliver the API integration'); await h.reply(second.id, 'approve', 702);
    expect((await h.db.query('SELECT next_action FROM tickets ORDER BY next_action')).rows).toEqual([
      { next_action: 'Deliver the API integration' }, { next_action: 'Prepare the integration test plan' },
    ]);
    expect((await h.service.list({})).items).toHaveLength(1);
  });

  it('keeps rejected, unanswered, stale and unrelated replies from creating Work', async () => {
    const h = await setup(); await h.approveCrm();
    const rejected = await h.work(); await h.reply(rejected.id, 'reject', 701);
    const pending = await h.work('work-2'); await h.bus.tick();
    await h.service.handleControlReply({ chatId: '-999', messageId: 702, replyToMessageId: 99999, senderId: '99', text: 'approve', sentAt: new Date().toISOString() });
    expect((await h.db.query('SELECT * FROM tickets')).rows).toEqual([]);
    await h.db.query("UPDATE messages SET text='Customer changed scope',version=version+1 WHERE chat_id=-1001");
    await h.reply(pending.id, 'approve', 703);
    expect((await h.db.query('SELECT * FROM tickets')).rows).toEqual([]);
  });

  it('rejects direct HTTP decisions, manual intake and legacy ticket creation', async () => {
    const h = await setup();
    const p = await h.service.propose({ relationshipId: h.relationship.id, expectedEvidenceRevision: h.relationship.evidenceRevision,
      targetStage: 'lead', reason: 'Review source', idempotencyKey: 'initial' });
    await expect(h.service.decide({ proposalId: p.id, action: 'approve', reason: 'Bypass', idempotencyKey: 'bypass' })).rejects.toThrow('Telegram');
    await expect(new RecordsRepository(h.db).ensureTicket('-1001')).rejects.toThrow('concrete Work action');
    await expect(h.store.decideIntakeManually('-1001', 'approved', 'Bypass')).rejects.toThrow('Telegram');
    await expect(new ProposalRepository(h.db, {} as ControlBus).decide({ proposalId: p.id as string, decision: 'approve', idempotencyKey: 'bypass-work' })).rejects.toThrow('Telegram');
  });

  it('queues CRM data edits and applies them only after a correlated Telegram approval', async () => {
    const h = await setup(); await h.approveCrm();
    const p = await h.service.updateActions({ relationshipId: h.relationship.id, expectedActionsVersion: 0,
      actions: [{ text: 'Send proposal', actor: 'antseed', state: 'open', precision: 'date', localDate: '2026-11-01', instant: null, timezone: 'Asia/Kolkata' }] });
    expect((await h.service.get(h.relationship.id)).actions).toEqual([]);
    await h.reply(p.id, 'approve', 701);
    expect((await h.service.get(h.relationship.id)).actions).toMatchObject([{ text: 'Send proposal', localDate: '2026-11-01' }]);
    const identity = await h.service.correctIdentity({ relationshipId: h.relationship.id, expectedIdentityVersion: 0, displayName: 'Reviewed company name', reason: 'Operator correction' });
    expect((await h.service.get(h.relationship.id)).relationship.displayName).not.toBe('Reviewed company name');
    await h.reply(identity.id, 'approve', 702);
    expect((await h.service.get(h.relationship.id)).relationship.displayName).toBe('Reviewed company name');
    expect((await h.db.query('SELECT * FROM tickets')).rows).toEqual([]);
  });

  it('queues Work data edits and source-fact corrections without changing data before approval', async () => {
    const h = await setup(); await h.approveCrm(); const p = await h.work(); await h.reply(p.id, 'approve', 701);
    const ticket = (await h.db.query('SELECT id FROM tickets')).rows[0]!;
    const evidence = (await h.db.query('SELECT id FROM evidence WHERE chat_id=-1001 LIMIT 1')).rows[0]!;
    const edit = await h.service.proposeRecordChange('work_actions', { ticketId: ticket.id, expectedActionsVersion: 0,
      idempotencyKey: 'work-edit', nextAction: 'Deliver the reviewed test plan', followUpAt: null, etaAt: null, evidenceIds: [evidence.id] }) as Record<string, unknown>;
    expect((await h.db.query('SELECT next_action FROM tickets')).rows[0]!.next_action).toBe('Prepare the integration test plan');
    await h.reply(edit.id, 'approve', 702);
    expect((await h.db.query('SELECT next_action FROM tickets')).rows[0]!.next_action).toBe('Deliver the reviewed test plan');
    const job = (await h.db.query('SELECT id FROM analysis_jobs LIMIT 1')).rows[0]!;
    const fact = (await h.db.query("INSERT INTO facts(job_id,kind,text) VALUES($1,'action','Prepare test plan') RETURNING id", [job.id])).rows[0]!;
    await h.db.query('INSERT INTO fact_evidence(fact_id,evidence_id) VALUES($1,$2)', [fact.id, evidence.id]);
    await h.service.reconcile();
    const correction = await h.service.proposeRecordChange('fact', { factId: fact.id, expectedVersion: 0, idempotencyKey: 'fact-edit',
      actor: { party: 'antseed', contactId: null, displayName: 'AntSeed' }, state: 'completed', answersFactId: null, dates: [], evidenceIds: [evidence.id] }) as Record<string, unknown>;
    expect((await h.db.query('SELECT state FROM facts WHERE id=$1', [fact.id])).rows[0]!.state).toBe('open');
    await h.reply(correction.id, 'approve', 703);
    expect((await h.db.query('SELECT state,source FROM facts WHERE id=$1', [fact.id])).rows[0]).toEqual({ state: 'completed', source: 'manual' });
  });

  it('proposes and approves Work movement through its own Telegram receipt without moving CRM', async () => {
    const h = await setup(); await h.approveCrm(); const work = await h.work(); await h.reply(work.id, 'approve', 701);
    const ticket = (await h.db.query('SELECT id FROM tickets')).rows[0]!;
    const evidence = (await h.db.query('SELECT id FROM evidence WHERE chat_id=-1001 LIMIT 1')).rows[0]!;
    const proposals = new ProposalRepository(h.db, h.bus);
    h.bus.subscribeOwner('operational', m => proposals.handleControlReply(m));
    const proposal = await proposals.propose({ ticketId: String(ticket.id), idempotencyKey: 'start-work', expectedStageVersion: 0,
      targetLane: 'Work in progress', evidenceIds: [String(evidence.id)], reason: 'The test plan work has started', nextAction: null, origin: 'manual' });
    await h.bus.tick();
    expect((await proposals.get(proposal.id)).decision).toBe('pending');
    const receipt = (await h.db.query('SELECT message_id FROM control_outbox WHERE proposal_id=$1', [proposal.id])).rows[0]!;
    await h.store.ingest({ type: 'message', message: { ...fixtureMessage(702, '-999', 'approve'), senderId: '99', replyToId: Number(receipt.message_id) } });
    await h.bus.tick();
    expect(await proposals.get(proposal.id)).toMatchObject({ decision: 'approved', applyState: 'queued' });
    expect((await h.service.get(h.relationship.id)).relationship).toMatchObject({ acceptedStage: 'qualification', stageVersion: 1 });
  });

  it('keeps existing Work cards and their stages while adding CRM parent links during migration', async () => {
    const db = await fixtureDatabase(migrations.slice(0, -1)); cleanup.push(() => db.close());
    const ticket = (await db.query("INSERT INTO tickets(chat_id,kind,lane,stage_version,vikunja_task_id) VALUES(-1001,'contact_prospect','Work in progress',3,42) RETURNING id")).rows[0]!;
    const service = new OutreachWorkflow(db, { now: () => new Date() }, config); await service.reconcile();
    const relationship = (await service.list({})).items[0]!;
    // The migration is intentionally exercised as one production transaction.
    const sql = await readFile(migrations.at(-1)!, 'utf8');
    await db.transaction(async tx => { for (const statement of sql.split(';').filter(s => s.trim())) await tx.query(statement); });
    expect((await db.query('SELECT id,lane,stage_version,vikunja_task_id,crm_relationship_id FROM tickets')).rows).toEqual([
      { id: ticket.id, lane: 'Work in progress', stage_version: 3, vikunja_task_id: 42, crm_relationship_id: relationship.id },
    ]);
    await service.reconcile();
    expect((await service.list({})).items).toHaveLength(1);
    expect((await service.get(relationship.id)).workTickets).toMatchObject([{ id: ticket.id, lane: 'Work in progress' }]);
  });

  it('does not accept native Work dragging as approval or change the accepted local lane', async () => {
    const h = await setup(); await h.approveCrm(); const p = await h.work(); await h.reply(p.id, 'approve', 701);
    await h.db.query("INSERT INTO board_buckets(lane,bucket_id) VALUES('Completed',33)");
    const ticket = (await h.db.query('SELECT id FROM tickets')).rows[0]!;
    expect(await h.db.transaction(tx => observeRemoteTx(tx, String(ticket.id), '33'))).toBe(false);
    expect((await h.db.query('SELECT lane,stage_version FROM tickets')).rows[0]).toEqual({ lane: 'To be started', stage_version: 0 });
  });

  it('suspends action tickets when their chat moves to a different CRM relationship instead of silently transferring Work', async () => {
    const h = await setup();
    const originalCompany = (await h.db.query("INSERT INTO companies(canonical_name) VALUES('Original CRM company') RETURNING id")).rows[0]!;
    await h.db.query("UPDATE chats SET mapping_status='confirmed',company_id=$1 WHERE id=-1001", [originalCompany.id]);
    await h.service.reconcile();
    await h.approveCrm(); const p = await h.work(); await h.reply(p.id, 'approve', 701);
    const ticket = (await h.db.query('SELECT id FROM tickets')).rows[0]!;
    const company = (await h.db.query("INSERT INTO companies(canonical_name) VALUES('Different CRM company') RETURNING id")).rows[0]!;
    await h.db.query("UPDATE chats SET mapping_status='confirmed',company_id=$1,mapping_version=mapping_version+1 WHERE id=-1001", [company.id]);
    await h.db.query("UPDATE tickets SET company_id=$1,kind='company' WHERE chat_id=-1001", [company.id]);
    await expect(new RecordsRepository(h.db).getContext({ ticketId: String(ticket.id), limit: 20 })).rejects.toThrow('approved CRM relationship');
    await h.service.reconcile();
    expect((await h.db.query('SELECT tracking_state,crm_relationship_id FROM tickets')).rows).toEqual([{ tracking_state: 'suspended', crm_relationship_id: h.relationship.id }]);
    expect((await h.service.get(h.relationship.id)).workTickets).toEqual([]);
    expect((await h.service.list({})).items[0]!.id).not.toBe(h.relationship.id);
  });

  it('approves chat intake into CRM without generating a Work record', async () => {
    const f = await telegramFixture({ approvalFirst: true }); cleanup.push(() => f.db.close());
    for (const migration of migrations.filter(url => !url.pathname.includes('operator_intake'))) await f.engine.exec(await readFile(migration, 'utf8'));
    await f.store.upsertDialog({ id: '-999', title: 'Approvals', kind: 'supergroup', username: null, archived: false });
    await f.db.query("UPDATE chats SET is_control=true,inclusion='excluded' WHERE id=-999");
    await f.store.upsertDialog({ id: '7', title: 'New CRM contact', kind: 'user', username: null, archived: false });
    await f.store.ingest({ type: 'message', message: { ...fixtureMessage(1, '7'), senderId: '7', sentAt: new Date(Date.now() + 1000).toISOString() } });
    let text = '';
    const port = { status: async () => ({ state: 'ready' }), sendControlMessage: async (i: { text: string }) => { text = i.text; return { messageId: 80 }; } } as unknown as TelegramPort;
    const bus = new DurableControlBus(f.db, port, f.store);
    await bus.tick(); expect(text).toContain('creates no Work ticket');
    await f.store.ingest({ type: 'message', message: { ...fixtureMessage(81, '-999', 'approve'), replyToId: 80 } }); await bus.tick();
    const service = new OutreachWorkflow(f.db, { now: () => new Date() }, config); await service.reconcile();
    expect((await service.list({})).items).toMatchObject([{ displayName: 'New CRM contact', acceptedStage: null }]);
    expect((await f.db.query('SELECT * FROM tickets')).rows).toEqual([]);
    expect((await f.store.getCursor('7')).status).toBe('pending');
  });
});
