import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureDatabase } from '../workflow/database.js';
import { connectClient } from '../hermes/client.js';
import { OutreachRepository } from '../../src/outreach/repository.js';
import { outreachPage } from '../../src/outreach/page.js';
import { registerTransports } from '../../src/hermes/module.js';
import { DomainError } from '../../src/shared/api.js';
import type { DomainServices } from '../../src/shared/ports.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function decode(result: unknown) { return (result as { structuredContent: Record<string, unknown> }).structuredContent; }

describe('Outreach canonical HTTP / official SDK parity', () => {
  it('reads the same persisted relationship/context over both transports with readiness and no write capability', async () => {
    const db = await fixtureDatabase([new URL('../../db/migrations/202610250001_outreach_core.sql', import.meta.url)]); cleanup.push(() => db.close());
    await db.query("INSERT INTO tickets(chat_id,kind,company_id) VALUES(-1001,'contact_prospect',NULL)");
    const outreach = new OutreachRepository(db, { now: () => new Date('2026-10-25T00:00:00Z') }); await outreach.reconcile();
    const app = Fastify(); let ready = true;
    const transports = registerTransports(app, { outreach } as unknown as DomainServices, async () => { if (!ready) throw new DomainError('upstream_unavailable', 'Checksum-validated migrations required', true); });
    app.addHook('preClose', () => transports.close());
    app.get('/outreach', (_request, reply) => reply.header('Cache-Control', 'no-store').type('text/html').send(outreachPage));
    const url = await app.listen({ host: '127.0.0.1', port: 0 }); cleanup.push(() => app.close());
    const client = await connectClient(url); cleanup.push(() => client.close());
    const list = await client.listTools();
    expect(list.tools.filter((t) => t.name.includes('outreach')).map((t) => t.name)).toEqual(['list_outreach_relationships', 'get_outreach_relationship']);
    expect(list.tools.filter((t) => t.name.includes('outreach')).every((t) => t.annotations?.readOnlyHint)).toBe(true);
    const http = await app.inject('/api/outreach/relationships?limit=2');
    expect(http.statusCode).toBe(200); expect(http.headers['cache-control']).toBe('no-store');
    expect(decode(await client.callTool({ name: 'list_outreach_relationships', arguments: { limit: 2 } }))).toEqual(http.json());
    const id = http.json().items[0].id as string;
    const detail = await app.inject('/api/outreach/relationships/' + id);
    expect(decode(await client.callTool({ name: 'get_outreach_relationship', arguments: { id } }))).toEqual(detail.json());
    expect(detail.json()).toMatchObject({ activeSources: [], pendingSources: [{ enrollmentState: 'pending' }] });
    expect((await app.inject('/outreach')).headers['cache-control']).toBe('no-store');
    for (const path of ['/api/outreach/relationships?stage=Completed', '/api/outreach/relationships?extra=true', '/api/outreach/relationships?limit=201', '/api/outreach/relationships/not-a-uuid']) expect((await app.inject(path)).statusCode).toBe(400);
    ready = false;
    expect((await app.inject('/api/outreach/relationships')).statusCode).toBe(503);
    expect(decode(await client.callTool({ name: 'get_outreach_relationship', arguments: { id } }))).toMatchObject({ error: { code: 'upstream_unavailable' } });
    expect((await db.query('SELECT count(*)::int n FROM proposals')).rows[0]!.n).toBe(0);
    expect((await db.query('SELECT count(*)::int n FROM mutations')).rows[0]!.n).toBe(0);
  });
});

describe('commercial command HTTP / Hermes contract',()=>{
 it('persists a Hermes recommendation, exposes HTTP-only approval and imports reports without direct tool approval',async()=>{
  const db=await fixtureDatabase([new URL('../../db/migrations/202610250001_outreach_core.sql',import.meta.url),new URL('../../db/migrations/202610260001_outreach_workflow.sql',import.meta.url)]);cleanup.push(()=>db.close());await db.query("INSERT INTO tickets(chat_id,kind) VALUES(-1001,'contact_prospect')");
  const {OutreachWorkflow}=await import('../../src/outreach/service.js');const service=new OutreachWorkflow(db,{now:()=>new Date()},{provider:'openai',endpoint:'https://api.openai.com/v1/decisions',model:'gpt-6-luna',apiKey:null,timeoutMs:1000,maxAttempts:1});await service.reconcile();const r=(await service.list({})).items[0]!;
  const app=Fastify();const transport=registerTransports(app,{outreach:service}as unknown as DomainServices,async()=>{});app.addHook('preClose',()=>transport.close());const url=await app.listen({host:'127.0.0.1',port:0});cleanup.push(()=>app.close());const client=await connectClient(url);cleanup.push(()=>client.close());
  const result=decode(await client.callTool({name:'propose_sales_stage',arguments:{relationshipId:r.id,expectedEvidenceRevision:r.evidenceRevision,idempotencyKey:'hermes-sales-contract',targetStage:'qualification',reason:'Source conversation reviewed'}}));expect(result).toMatchObject({state:'pending',origin:'hermes'});expect((await service.get(r.id)).relationship.acceptedStage).toBeNull();
  expect((await client.callTool({name:'decide_sales_proposal',arguments:{proposalId:result.id,action:'approve'}})).isError).toBe(true);
  const decision=await app.inject({method:'POST',url:'/api/outreach/proposals/'+result.id+'/decision',payload:{idempotencyKey:'http-sales-decision',action:'approve',reason:'Operator reviewed source'}});expect(decision.statusCode).toBe(200);expect((await service.get(r.id)).relationship).toMatchObject({acceptedStage:'qualification',stageVersion:1});
  expect(decode(await client.callTool({name:'get_sales_status',arguments:{}}))).toMatchObject({pending_publications:1});
  const raw={namespace:'http-report',checkedAt:'2026-10-26T00:00:00Z',coverage:'Synthetic report only',threads:[{key:'t1',companyName:'Synthetic Mail',title:'Email report',summary:'Sent an enquiry',sourceAt:null,contacts:[],provisionalStage:'lead',nextAction:'Follow up',claims:['First enquiry sent']}]};const preview=await app.inject({method:'POST',url:'/api/outreach/imports/preview',payload:raw});expect(preview.statusCode).toBe(200);const id=preview.json().id;expect((await app.inject({method:'POST',url:`/api/outreach/imports/${id}/commit`,payload:{}})).statusCode).toBe(200);expect((await service.list({query:'Synthetic Mail'})).items[0]).toMatchObject({displayStage:'lead',acceptedStage:null});
 });
});
