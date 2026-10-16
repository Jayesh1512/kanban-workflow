import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeFixture } from './fixture.js';
import { connectClient } from './client.js';
import { MCP_OPERATIONS } from '../../src/shared/api.js';

describe.skipIf(!process.env['WORKFLOW_TEST_PROJECT'])('actual HTTP + SDK + PostgreSQL + Vikunja (controlled inference fixtures)', () => {
  let h: Awaited<ReturnType<typeof nativeFixture>>, client: Awaited<ReturnType<typeof connectClient>>;
  beforeAll(async () => {
    h = await nativeFixture(); const url = await h.app.listen({ host: '127.0.0.1', port: 0 }); client = await connectClient(url);
    for (let i = 0; i < 100; i++) { const p = (await h.app.inject('/api/status')).json(); if (p.components.database.state === 'ready' && p.components.jev.code === 'provider_entitlement') return; await delay(100); }
    throw new Error('Owned synthetic stack did not become ready/paused');
  }, 30000);
  afterAll(async () => { await client?.close(); await h?.close(); });
  const json = (raw: unknown): any => JSON.parse((raw as { content: { text: string }[] }).content[0]!.text);
  async function tool(name: string, args: Record<string, unknown> = {}) { const value = await client.callTool({ name, arguments: args }); expect(value.isError, JSON.stringify(value)).not.toBe(true); return json(value); }
  async function http(method: 'GET' | 'POST' | 'PUT', url: string, payload?: Record<string, unknown>) { const response = await h.app.inject({ method, url, ...(payload ? { payload } : {}) }); expect(response.statusCode, response.body).toBe(200); return response.json(); }
  it('extends A status after A route registration, preserves configuration, shows durable pause, and sanitizes outage', async () => {
    const status = await http('GET', '/api/status'); expect(status.components).toMatchObject({ database: { state: 'ready' }, workflow: { state: 'degraded' }, extraction: { state: 'unconfigured' }, jev: { code: 'provider_entitlement' } }); expect(status.configuration).toMatchObject({ jevConfigured: true, extractionConfigured: false }); expect(status).toHaveProperty('imports');

  });
  it('uses shared records for HTTP/tool pagination, complete context, contacts, facts, evidence and priorities', async () => {
    expect((await client.listTools()).tools).toHaveLength(MCP_OPERATIONS.length);
    const companies = await http('GET', '/api/companies?limit=1'); expect(await tool('list_companies', { limit: 1 })).toEqual(companies);
    const company = await http('GET', `/api/companies/${h.h.ticket.companyId}`); expect(await tool('get_company', { id: company.id })).toEqual(company);
    const tickets = await tool('list_tickets', { companyId: company.id }); expect(tickets.items).toHaveLength(1);
    const ticket = await tool('get_ticket', { id: h.h.ticket.id }); expect(ticket.lane).toBe('To be started');
    expect(await tool('ensure_ticket', { chatId: '-1001' })).toEqual(await http('POST', '/api/tickets', { chatId: '-1001' }));
    const context = await http('GET', `/api/tickets/${ticket.id}/context?limit=50`); expect(await tool('get_ticket_context', { ticketId: ticket.id, limit: 50 })).toEqual(context); expect(JSON.stringify(context)).toContain('Mira');
    const contacts = await tool('list_contacts', { companyId: company.id }); expect(contacts.items.length).toBeGreaterThan(0); expect(await tool('get_contact', { id: contacts.items[0].id })).toEqual(await http('GET', `/api/contacts/${contacts.items[0].id}`));
    const facts = await http('GET', `/api/tickets/${ticket.id}/facts`); expect(await tool('list_ticket_facts', { ticketId: ticket.id })).toEqual(facts);
    expect(await tool('get_evidence', { ids: [h.h.evidenceId] })).toEqual(await http('POST', '/api/evidence/query', { ids: [h.h.evidenceId] }));
    expect(await tool('today_priorities', { date: '2026-10-17', timezone: 'Asia/Kolkata' })).toEqual(await http('GET', '/api/priorities/today?date=2026-10-17&timezone=Asia%2FKolkata'));
  });
  it('persists company/contact/action/fact updates with replay and optimistic conflict through both transports', async () => {
    const input = { idempotencyKey: 'm4-company', canonicalName: 'AntSeed M4 Synthetic Other', aliases: ['M4 Only'], domains: [], workstream: 'Others', summary: 'Synthetic owned fixture', buyerIds: [], providerIds: [], evidenceIds: [h.h.evidenceId] };
    const company = await tool('create_company', input); expect(await http('POST', '/api/companies', input)).toEqual(company);
    const changed = { ...input, idempotencyKey: 'm4-company-update', canonicalName: 'AntSeed M4 Synthetic Other updated', expectedVersion: company.version };
    const updated = await http('PUT', `/api/companies/${company.id}`, changed); expect(await tool('update_company', { ...changed, id: company.id })).toEqual(updated);
    const stale = await client.callTool({ name: 'update_company', arguments: { ...changed, id: company.id, idempotencyKey: 'stale-company' } }); expect(stale.isError).toBe(true); expect(json(stale).error.code).toBe('conflict');
    const contactInput = { idempotencyKey: 'm4-contact', telegramUserIds: [], names: ['M4 Synthetic Operator'], usernames: [], phones: [], emails: [], affiliation: 'unknown', roles: [], evidenceIds: [h.h.evidenceId] };
    const contact = await http('POST', '/api/contacts', contactInput); expect(await tool('create_contact', contactInput)).toEqual(contact);
    const contactUpdate = { ...contactInput, idempotencyKey: 'm4-contact-update', names: ['M4 Synthetic Operator corrected'], expectedVersion: contact.version };
    expect(await tool('update_contact', { ...contactUpdate, id: contact.id })).toEqual(await http('PUT', `/api/contacts/${contact.id}`, contactUpdate));
    const ticket = await tool('get_ticket', { id: h.h.ticket.id }); const actions = { idempotencyKey: 'm4-actions', expectedActionsVersion: ticket.actionsVersion, nextAction: 'Synthetic operator follow-up', followUpAt: null, etaAt: null, evidenceIds: [h.h.evidenceId] };
    expect(await tool('update_ticket_actions', { ...actions, ticketId: ticket.id })).toEqual(await http('PUT', `/api/tickets/${ticket.id}/actions`, actions));
    const facts = await tool('list_ticket_facts', { ticketId: ticket.id }); const fact = facts.items[0];
    const correction = { idempotencyKey: 'm4-fact', expectedVersion: fact.version, state: 'completed', actor: fact.actor, evidenceIds: fact.evidenceIds, answersFactId: null, dates: [] };
    expect(await tool('update_fact', { ...correction, factId: fact.id })).toEqual(await http('PUT', `/api/facts/${fact.id}`, correction));
  });
  it('keeps Hermes proposals pending, HTTP corrections separately pending, rejects stale evidence and never moves a lane', async () => {
    const t = await tool('get_ticket', { id: h.h.ticket.id });
    const input = { idempotencyKey: 'm4-proposal', ticketId: t.id, expectedStageVersion: t.stageVersion, targetLane: 'Integrations', evidenceIds: [h.h.evidenceId], reason: 'Synthetic pilot is underway', nextAction: null };
    const p = await tool('propose_lane_change', input); expect(p).toMatchObject({ decision: 'pending', origin: 'hermes' }); expect(await tool('propose_lane_change', input)).toEqual(p);
    expect(await tool('get_proposal', { id: p.id })).toEqual(await http('GET', `/api/proposals/${p.id}`)); expect((await tool('list_proposals', { ticketId: t.id, decision: 'pending' })).items.some((v: { id: string }) => v.id === p.id)).toBe(true);
    const correction = await http('POST', `/api/proposals/${p.id}/decision`, { idempotencyKey: 'm4-correct', decision: 'correct', targetLane: 'Blocked', reason: 'Synthetic explicit dependency', evidenceIds: [h.h.evidenceId] }); expect(correction.proposal.decision).toBe('corrected'); expect(correction.replacement.decision).toBe('pending');
    const rejected = await http('POST', `/api/proposals/${correction.replacement.id}/decision`, { idempotencyKey: 'm4-reject', decision: 'reject', note: 'Synthetic rejection' }); expect(rejected.proposal.decision).toBe('rejected');
    const stale = await tool('propose_lane_change', { ...input, idempotencyKey: 'm4-stale' }); await h.db.query('UPDATE messages SET version=version+1 WHERE chat_id=-1001 AND id=1');
    const response = await h.app.inject({ method: 'POST', url: `/api/proposals/${stale.id}/decision`, payload: { idempotencyKey: 'stale-approval', decision: 'approve' } }); expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('stale_proposal');
    expect((await tool('get_ticket', { id: t.id })).lane).toBe('To be started'); expect((await h.db.query('SELECT count(*) FROM mutations')).rows[0]!.count).toBe('0');
  });
  it('exposes all six chat tools through A services, honors exclusions, and explicit replay is idempotent in a no-live-credential fixture', async () => {
    const list = await tool('list_chats'); expect(list).toEqual(await http('GET', '/api/chats')); const chat = list.items[0];
    const imported = await tool('request_import', { chatId: chat.id, idempotencyKey: 'm4-import', maxBatches: 1, batchSize: 20 }); expect(imported.chatId).toBe(chat.id);
    expect(await tool('get_import_status', { chatId: chat.id })).toEqual(await http('GET', `/api/chats/${chat.id}/import`));
    expect(await tool('get_mapping_candidates', { chatId: chat.id })).toEqual(await http('GET', `/api/chats/${chat.id}/mapping`));
    const mapping = await tool('correct_company_mapping', { chatId: chat.id, idempotencyKey: 'm4-mapping', expectedMappingVersion: chat.mappingVersion, status: 'unresolved', companyId: null, evidenceIds: [], reason: 'Synthetic operator correction' }); expect(mapping.mappingStatus).toBe('unresolved');
    const excluded = await tool('set_chat_inclusion', { chatId: chat.id, idempotencyKey: 'm4-exclude', expectedPolicyVersion: chat.policyVersion, inclusion: 'excluded' }); expect(excluded.inclusion).toBe('excluded');
    const proposal = await client.callTool({ name: 'propose_lane_change', arguments: { idempotencyKey: 'excluded', ticketId: h.h.ticket.id, expectedStageVersion: 0, targetLane: 'Blocked', evidenceIds: [h.h.evidenceId], reason: 'Synthetic', nextAction: null } }); expect(proposal.isError).toBe(true);
    // No configured real key and excluded source: explicit replay cannot issue a live request.
    const replay = { idempotencyKey: 'm4-replay', chatId: chat.id }; expect(await tool('replay_analysis', replay)).toEqual(await http('POST', '/api/analysis/replay', replay));
  });
  it('keeps real discovery reachable while a wrong migration checksum fences all business ingress', async () => {
    const prior = (await h.db.query("SELECT checksum FROM schema_migrations WHERE version='001_initial.sql'")).rows[0]!.checksum;
    await h.db.query("UPDATE schema_migrations SET checksum='deliberate-drift' WHERE version='001_initial.sql'");
    try {
      expect((await client.listTools()).tools).toHaveLength(MCP_OPERATIONS.length);
      const response = await h.app.inject('/api/companies'); expect(response.statusCode).toBe(503);
      const result = await client.callTool({ name: 'list_companies', arguments: {} }); expect(result.isError).toBe(true); expect(json(result).error.code).toBe('upstream_unavailable');
      expect((await h.app.inject('/api/status')).statusCode).toBe(200);
    } finally { await h.db.query("UPDATE schema_migrations SET checksum=$1 WHERE version='001_initial.sql'", [prior]); }
  });
  it('preserves the onboarding status response during database outage', async () => {
    const spy = vi.spyOn(h.platform.services.db, 'query').mockRejectedValue(Object.assign(new Error('PRIVATE DB ENDPOINT'), { code: '08006' }));
    try { const outage = await http('GET', '/api/status'); expect(outage.components.jev).toMatchObject({ state: 'unavailable', code: 'database_unavailable' }); expect(JSON.stringify(outage)).not.toContain('PRIVATE'); } finally { spy.mockRestore(); }
  });
});
