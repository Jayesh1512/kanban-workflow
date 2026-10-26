import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { connectClient } from './client.js';
import { API_OPERATIONS, MCP_OPERATIONS, DomainError } from '../../src/shared/api.js';
import type { DomainServices } from '../../src/shared/ports.js';
import { registerTransports } from '../../src/hermes/module.js';

const id = '00000000-0000-4000-8000-000000000001';
const company = { idempotencyKey: 'company', canonicalName: 'Synthetic transport company', aliases: [], domains: [], workstream: 'Buyer', summary: '', buyerIds: [], providerIds: [], evidenceIds: [] };
const contact = { idempotencyKey: 'contact', telegramUserIds: [], names: ['Synthetic contact'], usernames: [], phones: [], emails: [], affiliation: 'unknown', evidenceIds: [], roles: [] };
const input: Record<string, Record<string, unknown>> = {
  'outreach.propose':{relationshipId:id,idempotencyKey:'sales',expectedEvidenceRevision:0,targetStage:'qualification',reason:'Substantive evaluation'},
  'outreach.listProposals':{},'outreach.getProposal':{id},'outreach.decide':{proposalId:id,idempotencyKey:'sales-decision',action:'approve',reason:'Operator review'},
  'outreach.previewImport':{namespace:'synthetic',checkedAt:'2026-10-26T00:00:00Z',coverage:'Synthetic report',threads:[{key:'thread',companyName:'Cedar',title:'Synthetic email',summary:'Reported conversation',sourceAt:null,contacts:[],provisionalStage:'lead',nextAction:'Follow up',claims:['First email sent']}]},
  'outreach.commitImport':{id},'outreach.getImport':{id},'outreach.updateActions':{relationshipId:id,expectedActionsVersion:0,actions:[]},'outreach.assess':{relationshipId:id,expectedEvidenceRevision:0},'outreach.correctIdentity':{relationshipId:id,expectedIdentityVersion:0,displayName:'Cedar',reason:'Operator correction'},'outreach.status':{},'outreach.setMode':{mode:'observe'},
  'outreach.list': { limit: 2 }, 'outreach.get': { id },
  'chats.list': { limit: 2 }, 'chats.setInclusion': { idempotencyKey: 'include', chatId: '-1001', inclusion: 'included', expectedPolicyVersion: 0 }, 'chats.importStatus': { chatId: '-1001' }, 'chats.requestImport': { chatId: '-1001', idempotencyKey: 'import', maxBatches: 1, batchSize: 20 }, 'chats.mappingCandidates': { chatId: '-1001' }, 'chats.correctMapping': { chatId: '-1001', expectedMappingVersion: 0, idempotencyKey: 'mapping', status: 'unresolved', companyId: null, evidenceIds: [], reason: 'Synthetic correction' },
  'records.listCompanies': { limit: 2, query: 'Synthetic' }, 'records.getCompany': { id }, 'records.createCompany': company, 'records.updateCompany': { ...company, id, expectedVersion: 0 }, 'records.listContacts': { companyId: id }, 'records.getContact': { id }, 'records.createContact': contact, 'records.updateContact': { ...contact, id, expectedVersion: 0 }, 'records.listTickets': { lane: 'To be started' }, 'records.getTicket': { id }, 'records.ensureTicket': { chatId: '-1001' }, 'records.getContext': { ticketId: id, limit: 10 }, 'records.getEvidence': { ids: [id] },
  'records.updateActions': { ticketId: id, idempotencyKey: 'actions', expectedActionsVersion: 0, nextAction: null, followUpAt: null, etaAt: null, evidenceIds: [] }, 'records.listFacts': { ticketId: id }, 'records.updateFact': { factId: id, idempotencyKey: 'fact', expectedVersion: 0, state: 'completed', actor: { party: 'antseed', contactId: null, displayName: 'AntSeed' }, evidenceIds: [], answersFactId: null, dates: [] }, 'records.priorities': { limit: 20, date: '2026-10-17', timezone: 'Asia/Kolkata' },
  'proposals.propose': { idempotencyKey: 'propose', ticketId: id, expectedStageVersion: 0, targetLane: 'Integrations', evidenceIds: [id], reason: 'Synthetic pilot evidence', nextAction: null }, 'proposals.list': { ticketId: id, decision: 'pending' }, 'proposals.get': { id }, 'proposals.decide': { idempotencyKey: 'approve', proposalId: id, decision: 'approve' }, 'analysis.replayUnavailable': { idempotencyKey: 'replay', chatId: '-1001' },
};
const close: (() => Promise<unknown>)[] = []; afterEach(async () => { for (const f of close.splice(0).reverse()) await f(); });
async function harness() {
  const calls: { service: string; args: unknown[] }[] = []; let failure: unknown = null, ready = true; let hold: (() => Promise<void>) | null = null;
  const make = (name: string) => new Proxy({}, { get(_target, method) { return async (...args: unknown[]) => { if (failure) throw failure; await hold?.(); calls.push({ service: `${name}.${String(method)}`, args }); return { service: `${name}.${String(method)}`, args }; }; } });
  const services = { chats: make('chats'), records: make('records'), proposals: make('proposals'), analysis: make('analysis'), outreach: make('outreach') } as DomainServices;
  const app = Fastify(); const transports = registerTransports(app, services, async () => { if (!ready) throw new DomainError('upstream_unavailable', 'Database migrations are not ready', true); });
  const url = await app.listen({ host: '127.0.0.1', port: 0 }); close.push(() => app.close()); close.push(() => transports.close());
  const client = await connectClient(url); close.push(() => client.close());
  return { app, url, client, calls, transports, hold(work: () => Promise<void>) { hold = work; }, fail(error: unknown) { failure = error; }, readiness(value: boolean) { ready = value; } };
}
function result(raw: unknown): any { const value = raw as { content: { type: string; text: string }[] }; return JSON.parse(value.content[0]!.text); }

describe('actual SDK Streamable HTTP and catalog binding contract (synthetic services)', () => {
  it('negotiates initialize/list and dispatches every allowed MCP operation to its exact domain method', async () => {
    const h = await harness(); expect(h.client.getServerVersion()).toMatchObject({ name: 'antseed' });
    const list = await h.client.listTools(); expect(list.tools.map((t) => t.name)).toEqual(MCP_OPERATIONS.map((o) => o.tool));
    expect(list.tools.some((t) => /decide|approve|move|send|login/.test(t.name))).toBe(false);
    for (const operation of MCP_OPERATIONS) {
      const response = await h.client.callTool({ name: operation.tool!, arguments: input[operation.service]! }); expect(response.isError).not.toBe(true);
      expect(result(response).service).toBe(operation.service); expect(h.calls.at(-1)!.service).toBe(operation.service);
      if (operation.service === 'proposals.propose') expect(h.calls.at(-1)!.args[0]).toMatchObject({ origin: 'hermes' });
      if (operation.service === 'chats.correctMapping') expect(h.calls.at(-1)!.args[0]).toMatchObject({ source: 'mcp' });
    }
    expect(h.calls).toHaveLength(MCP_OPERATIONS.length);
  });
  it('binds all B HTTP operations with direct port responses and path/query adaptation; A owns all six chat routes', async () => {
    const h = await harness();
    for (const operation of API_OPERATIONS) {
      if (operation.service.startsWith('chats.')) { expect(h.app.hasRoute({ method: operation.method, url: operation.path })).toBe(false); continue; }
      const data = { ...input[operation.service]! }; const path = operation.path.replace(/:([A-Za-z]+)/g, (_whole, key: string) => { const value = String(data[key]); delete data[key]; return value; });
      const query = new URLSearchParams(Object.entries(data).map(([key, value]) => [key, String(value)])).toString();
      const response = await h.app.inject({ method: operation.method, url: operation.method === 'GET' ? `${path}?${query}` : path, ...(operation.method !== 'GET' ? { payload: data } : {}) });
      expect(response.statusCode, `${operation.method} ${path}: ${response.body}`).toBe(200); expect(response.json().service).toBe(operation.service);
      if (operation.service === 'proposals.propose') expect(response.json().args[0]).toMatchObject({ origin: 'manual' });
    }
  });
  it('rejects malformed parameters, extra keys, provenance spoofing and approval escape tools without service calls', async () => {
    const h = await harness();
    for (const [name, args] of [['list_companies', { limit: '2' }], ['get_company', { id: 'invalid' }], ['list_tickets', { lane: 'Invented' }], ['propose_lane_change', { ...input['proposals.propose'], origin: 'jev' }], ['correct_company_mapping', { ...input['chats.correctMapping'], source: 'http' }], ['today_priorities', { timezone: 'not/a/timezone' }], ['decide_proposal', input['proposals.decide']], ['get_ticket', { id, escape: true }]] as const) {
      const response = await h.client.callTool({ name, arguments: args }); expect(response.isError).toBe(true); expect(result(response)).toMatchObject({ error: { code: 'validation', retryable: false, requestId: expect.any(String) } });
    }
    for (const url of ['/api/companies?limit=0x10', '/api/companies?limit=1&limit=2', '/api/companies?unknown=true', '/api/companies/not-a-uuid', `/api/companies/${id}?id=other`, '/api/priorities/today?timezone=bad']) expect((await h.app.inject({ method: 'GET', url })).statusCode).toBe(400);
    expect((await h.app.inject({ method: 'PUT', url: `/api/companies/${id}`, payload: { ...company, id: '00000000-0000-4000-8000-000000000002', expectedVersion: 0 } })).statusCode).toBe(400);
    expect((await h.app.inject({ method: 'POST', url: '/api/companies', payload: '{', headers: { 'content-type': 'application/json' } })).json()).toMatchObject({ error: { code: 'validation' } }); expect(h.calls).toHaveLength(0);
  });
  it.each([['not_found', 404], ['conflict', 409], ['stale_proposal', 409], ['excluded_chat', 409], ['ambiguous_mapping', 409], ['upstream_unavailable', 503], ['not_configured', 503]] as const)('normalizes %s consistently across HTTP and tool errors', async (code, status) => {
    const h = await harness(); h.fail(new DomainError(code, 'Synthetic domain result', code === 'upstream_unavailable'));
    const http = await h.app.inject({ method: 'GET', url: `/api/companies/${id}` }); expect(http.statusCode).toBe(status); const mcp = await h.client.callTool({ name: 'get_company', arguments: { id } }); expect(mcp.isError).toBe(true);
    expect(result(mcp).error).toMatchObject({ ...http.json().error, requestId: expect.any(String) });
  });
  it('keeps initialize/discovery reachable while business readiness is unavailable and never reflects unexpected errors', async () => {
    const h = await harness(); h.readiness(false); expect((await h.client.listTools()).tools).toHaveLength(MCP_OPERATIONS.length);
    expect(result(await h.client.callTool({ name: 'list_companies', arguments: {} }))).toMatchObject({ error: { code: 'upstream_unavailable' } }); expect((await h.app.inject('/api/companies')).statusCode).toBe(503); expect(h.calls).toHaveLength(0);
    h.readiness(true); h.fail(new Error('PRIVATE-UPSTREAM-DETAIL')); const response = await h.client.callTool({ name: 'list_companies', arguments: {} }); expect(JSON.stringify(response)).not.toContain('PRIVATE'); expect(result(response).error.code).toBe('internal');
  });
  it('uses SDK protocol errors for malformed envelopes and stateless GET/DELETE behavior', async () => {
    const h = await harness();
    const send = (body: string) => fetch(`${h.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body });
    const malformed = await send('{'); expect(malformed.status).toBe(400); expect(await malformed.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32700 } });
    const invalid = await send(JSON.stringify({ unrelated: true })); expect(invalid.status).toBe(400); expect(await invalid.json()).toMatchObject({ jsonrpc: '2.0', error: expect.any(Object) });
    for (const method of ['GET', 'DELETE']) { const response = await fetch(`${h.url}/mcp`, { method, headers: { accept: 'text/event-stream' } }); expect(response.status).toBe(405); await response.body?.cancel(); }
  });
  it('rejects new requests during stop and drains a captured domain call after MCP disconnect', async () => {
    const h = await harness(); let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>((r) => { release = r; }); const started = new Promise<void>((r) => { entered = r; });
    h.hold(async () => { entered(); await waiting; });
    const pending = h.client.callTool({ name: 'get_company', arguments: { id } }).catch(() => null); await started;
    let stopped = false; const closing = h.transports.close().then(() => { stopped = true; });
    await new Promise((r) => setTimeout(r, 10)); expect(stopped).toBe(false);
    const response = await h.app.inject('/api/companies'); expect(response.statusCode).toBe(503); expect(h.calls).toHaveLength(0);
    release(); await closing; await pending; expect(h.calls).toHaveLength(1); expect(stopped).toBe(true);
  });

});
