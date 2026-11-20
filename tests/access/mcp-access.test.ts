import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { buildApp } from '../../src/app.js';
import { AccessControl } from '../../src/access/service.js';
import { resendMailer, type Mailer } from '../../src/access/mcp-keys.js';
import { registerBoard } from '../../src/board/routes.js';
import { registerScopedMcp } from '../../src/hermes/scoped.js';
import { OutreachWorkflow } from '../../src/outreach/service.js';
import { ProposalRepository } from '../../src/workflow/proposals.js';
import { TelegramStore } from '../../src/telegram/store.js';
import type { PgDatabase } from '../../src/platform/database.js';
import { fixtureDatabase } from '../workflow/database.js';

const names=['202610250001_outreach_core.sql','202610260001_outreach_workflow.sql','202610260002_stable_outreach_sources.sql','202610270004_operator_intake_approvals.sql','202610280001_crm_first.sql','202610290001_native_workspace.sql','202610300001_work_task_ownership.sql','202610310001_ticket_headline.sql','202611200001_initial_placement_removal.sql','202611200003_manual_work_cards.sql','202611200004_manual_crm_cards.sql','202611010001_mcp_access.sql'];
const cleanup:Array<()=>Promise<unknown>>=[];
// Most cases exercise team propose/requests; the read-only default is covered separately below.
beforeEach(()=>{process.env['MCP_TEAM_ELEVATED']='on';});
afterEach(async()=>{delete process.env['MCP_TEAM_ELEVATED'];for(const close of cleanup.splice(0).reverse())await close();});

/** Real Fastify routes, MCP SDK client and a local Auth boundary over an isolated PostgreSQL engine; never touches hosted services. */
async function setup(emailConfigured=true){
  const db=await fixtureDatabase(names.map(name=>new URL(`../../db/migrations/${name}`,import.meta.url)));cleanup.push(()=>db.close());
  const identities=new Map(['ravi@antseed.com','member@example.com','viewer@example.com','manager@example.com'].map(email=>[email,{id:randomUUID(),email,email_confirmed_at:'2026-10-29T00:00:00Z'}]));
  const provider=Fastify();
  provider.get('/auth/v1/user',async(req,reply)=>identities.get(req.headers.authorization?.replace('Bearer ','')??'')??reply.code(401).send({error:'Invalid token'}));
  provider.get('/auth/v1/.well-known/jwks.json',async()=>({keys:[]}));
  provider.get('/auth/v1/settings',async()=>({mailer_autoconfirm:false}));
  const origin=await provider.listen({host:'127.0.0.1',port:0});cleanup.push(()=>provider.close());
  const mail:Array<Parameters<Mailer>[0]>=[];
  const mailer:Mailer=emailConfigured?async message=>{mail.push(message);return 'sent';}:resendMailer(null,'AntSeed <onboarding@resend.dev>');
  const config={supabaseUrl:origin,publishableKey:'synthetic-public-key',adminEmail:'ravi@antseed.com',appUrl:'http://localhost:19491',crmApproval:'direct' as const,resendApiKey:emailConfigured?'synthetic':null};
  const access=new AccessControl(db,config,fetch,mailer);
  const app=await buildApp();cleanup.push(()=>app.close());await access.register(app);app.decorate('workspaceAccess',access);
  const outreach=new OutreachWorkflow(db,{now:()=>new Date()},{provider:'openai',endpoint:'https://api.openai.com/v1/decisions',model:'gpt-6-luna',apiKey:null,timeoutMs:1000,maxAttempts:1},{nativeBoard:true});
  const work=new ProposalRepository(db,{subscribe:()=>()=>{},enqueueProposal:async()=>{}});
  const intake=new TelegramStore(db as unknown as PgDatabase,{apiId:null,apiHash:null,sessionPath:'',historyBatchSize:10,historyMaxBatches:1});
  registerBoard(app,db,outreach,async()=>{},'Asia/Kolkata',{work,intake});
  const scoped=registerScopedMcp(app,db,outreach,async()=>{},{timezone:'Asia/Kolkata',access:config});cleanup.push(()=>scoped.close());
  app.post('/mcp',async request=>({member:access.user(request).email,key:access.mcpKey(request)?.surface??null})); // stand-in for the admin catalog
  await access.identify('ravi@antseed.com');
  for(const [key,role] of [['member','member'],['viewer','viewer'],['manager','crm_manager']] as const){
    await db.query('INSERT INTO workspace_members(email,role) VALUES($1,$2)',[`${key}@example.com`,role]);await access.identify(`${key}@example.com`);
  }
  const headers=(who:string)=>({authorization:`Bearer ${who==='admin'?'ravi@antseed.com':who+'@example.com'}`});
  await outreach.reconcile();const unplaced=(await outreach.listReviewRelationships({})).items[0]!;
  expect((await app.inject({method:'POST',url:`/api/board/approvals/relationships/${unplaced.id}/place`,headers:headers('manager'),
    payload:{targetStage:'lead',expectedEvidenceRevision:unplaced.evidenceRevision,idempotencyKey:randomUUID(),reason:'Synthetic placement'}})).statusCode).toBe(200);
  const placed=(await outreach.get(unplaced.id)).relationship;
  const proposal=await outreach.proposeWork({relationshipId:placed.id,chatId:'-1001',expectedEvidenceRevision:placed.evidenceRevision,action:'Prepare the integration plan',reason:'Synthetic Work',idempotencyKey:randomUUID()});
  expect((await app.inject({method:'POST',url:`/api/board/approvals/proposals/${proposal.id}/decision`,headers:headers('manager'),payload:{action:'approve',reason:'ok',idempotencyKey:randomUUID()}})).statusCode).toBe(200);
  const adminId=String((await db.query("SELECT id FROM workspace_members WHERE email='ravi@antseed.com'")).rows[0]!.id);
  const ticketId=String((await db.query('UPDATE tickets SET owner_id=$1 WHERE crm_relationship_id=$2 RETURNING id',[adminId,placed.id])).rows[0]!.id);
  const url=await app.listen({host:'127.0.0.1',port:0});
  const key=async(who:string,payload:Record<string,unknown>)=>{const r=await app.inject({method:'POST',url:'/api/mcp-keys',headers:headers(who),payload});return {status:r.statusCode,body:r.json()};};
  const client=async(path:string,token:string)=>{
    const c=new Client({name:'mcp-access-test',version:'1'});const transport=new StreamableHTTPClientTransport(new URL(path,url),{requestInit:{headers:{authorization:`Bearer ${token}`}}});
    const wire:Transport={start:()=>transport.start(),send:(m,o)=>transport.send(m,o),close:()=>transport.close(),setProtocolVersion:v=>transport.setProtocolVersion(v)};
    transport.onmessage=m=>wire.onmessage?.(m);transport.onclose=()=>wire.onclose?.();transport.onerror=e=>wire.onerror?.(e);
    await c.connect(wire);cleanup.push(()=>c.close());return c;
  };
  const call=async(c:Client,name:string,args:Record<string,unknown>)=>{const r=await c.callTool({name,arguments:args}) as {isError?:boolean;content:{text:string}[]};return {error:!!r.isError,value:JSON.parse(r.content[0]!.text)};};
  return {db,app,outreach,headers,mail,key,client,call,relationshipId:placed.id,ticketId,adminId};
}
const toolNames=async(c:Client)=>(await c.listTools()).tools.map(t=>t.name).sort();

describe('scoped MCP keys, levels and admin approval (local SQL engine, synthetic Auth)',()=>{
  it('lets members create only propose-level CRM keys, authenticates keys per connection and honours revocation',async()=>{
    const h=await setup();
    expect((await h.key('member',{surface:'crm',level:'full'})).status).toBe(403);
    expect((await h.key('member',{surface:'tasks'})).status).toBe(403);
    expect((await h.key('member',{surface:'admin'})).status).toBe(403);
    const created=await h.key('member',{surface:'crm',label:'Hermes'});
    expect(created.status).toBe(200);expect(created.body.key).toMatch(/^ask_[A-Za-z0-9_-]{43}$/);expect(created.body.item.level).toBe('propose');
    const listed=(await h.app.inject({url:'/api/mcp-keys',headers:h.headers('member')})).json();
    expect(JSON.stringify(listed)).not.toContain(created.body.key);expect(listed.endpoints).toEqual({crm:'http://localhost:19491/mcp/crm',tasks:'http://localhost:19491/mcp/tasks',admin:'http://localhost:19491/mcp'});
    expect((await h.db.query('SELECT key_hash<>$1 AS hashed FROM mcp_keys WHERE id=$2',[created.body.key,created.body.item.id])).rows[0]).toEqual({hashed:true});
    expect((await h.app.inject({method:'POST',url:'/mcp/tasks',headers:{authorization:`Bearer ${created.body.key}`,'content-type':'application/json'},payload:{}})).statusCode).toBe(403);
    expect((await h.app.inject({method:'POST',url:'/mcp/crm',headers:{authorization:`Bearer ask_${'x'.repeat(43)}`,'content-type':'application/json'},payload:{}})).statusCode).toBe(401);
    expect((await h.app.inject({method:'POST',url:'/mcp/crm',headers:{...h.headers('member'),'content-type':'application/json'},payload:{}})).statusCode).toBe(401);
    expect((await h.app.inject({method:'POST',url:'/mcp',headers:{authorization:`Bearer ${created.body.key}`},payload:{}})).statusCode).toBe(403);
    const c=await h.client('/mcp/crm',created.body.key);
    expect(await toolNames(c)).toEqual(['add_note','edit_deal','follow_ups_due','get_deal','move_deal','pipeline_summary','search_deals']);
    expect((await h.call(c,'pipeline_summary',{})).value.total).toBe(1);
    expect((await h.db.query('SELECT last_used_at IS NOT NULL AS used FROM mcp_keys WHERE id=$1',[created.body.item.id])).rows[0]).toEqual({used:true});
    expect((await h.app.inject({method:'DELETE',url:`/api/mcp-keys/${created.body.item.id}`,headers:h.headers('viewer')})).statusCode).toBe(403);
    expect((await h.app.inject({method:'DELETE',url:`/api/mcp-keys/${created.body.item.id}`,headers:h.headers('member')})).json()).toEqual({revoked:true});
    expect((await h.app.inject({method:'POST',url:'/mcp/crm',headers:{authorization:`Bearer ${created.body.key}`,'content-type':'application/json'},payload:{}})).statusCode).toBe(401);
  });

  it('turns propose-level CRM changes into approvals, keeps viewers read-only and applies full-level changes directly',async()=>{
    const h=await setup();
    const member=await h.client('/mcp/crm',(await h.key('member',{surface:'crm'})).body.key);
    const moved=await h.call(member,'move_deal',{id:h.relationshipId,targetStage:'qualification',reason:'Call booked'});
    expect(moved.value.mode).toBe('proposed');expect((await h.outreach.get(h.relationshipId)).relationship.acceptedStage).toBe('lead');
    const edited=await h.call(member,'edit_deal',{id:h.relationshipId,summary:'Agent notes',reason:'Context from call'});
    expect(edited.value.proposals).toHaveLength(1);
    const pending=(await h.db.query("SELECT id,command_kind,origin FROM outreach_sales_proposals WHERE relationship_id=$1 AND state='pending' ORDER BY created_at",[h.relationshipId])).rows;
    expect(pending.map(p=>[p.command_kind,p.origin])).toEqual([['stage','hermes'],['details','hermes']]);
    const details=pending.find(p=>p.command_kind==='details')!;
    expect((await h.app.inject({method:'POST',url:`/api/board/approvals/proposals/${details.id}/decision`,headers:h.headers('manager'),payload:{action:'approve',reason:'ok',idempotencyKey:randomUUID()}})).statusCode).toBe(200);
    expect((await h.outreach.get(h.relationshipId)).relationship.summary).toBe('Agent notes');
    expect((await h.db.query("SELECT 1 FROM workspace_audit WHERE resource_id=$1 AND action='crm.propose' AND after_value->>'source'='mcp'",[h.relationshipId])).rowCount).toBe(2);

    const viewer=await h.client('/mcp/crm',(await h.key('viewer',{surface:'crm'})).body.key);
    expect(await toolNames(viewer)).toEqual(['follow_ups_due','get_deal','pipeline_summary','search_deals']);
    expect((await h.call(viewer,'move_deal',{id:h.relationshipId,targetStage:'won',reason:'x'})).value.error.code).toBe('forbidden');

    const fullMember=await h.key('member',{surface:'crm'});
    expect((await h.app.inject({method:'PATCH',url:`/api/mcp-keys/${fullMember.body.item.id}`,headers:h.headers('admin'),payload:{level:'full'}})).statusCode).toBe(200);
    const stillProposes=await h.client('/mcp/crm',fullMember.body.key); // Role still applies: a member never moves CRM directly.
    expect((await h.call(stillProposes,'add_note',{id:h.relationshipId,note:'Sent deck'})).value.mode).toBe('proposed');

    const admin=await h.client('/mcp/crm',(await h.key('admin',{surface:'crm',level:'full'})).body.key);
    expect((await h.call(admin,'move_deal',{id:h.relationshipId,targetStage:'negotiation',reason:'Terms sent'})).value.mode).toBe('saved');
    expect((await h.outreach.get(h.relationshipId)).relationship.acceptedStage).toBe('negotiation');
    expect((await h.call(admin,'edit_deal',{id:h.relationshipId,displayName:'Cedar Labs',nextAction:'Send contract',followUpDate:'2026-11-09'})).value.mode).toBe('saved');
    expect((await h.outreach.get(h.relationshipId)).relationship).toMatchObject({displayName:'Cedar Labs',summary:'Agent notes'});
    expect((await h.call(admin,'follow_ups_due',{withinDays:60})).value.items[0]).toMatchObject({next_action:'Send contract',due_date:'2026-11-09'});
    expect((await h.db.query("SELECT 1 FROM workspace_audit WHERE resource_id=$1 AND action='crm.update' AND after_value->>'source'='mcp'",[h.relationshipId])).rowCount).toBe(1);
  });

  it('keeps the team read-only by default: read tools only and no access requests',async()=>{
    delete process.env['MCP_TEAM_ELEVATED'];
    const h=await setup();
    const created=await h.key('member',{surface:'crm',label:'Hermes'});
    expect(created.status).toBe(200);
    expect(await toolNames(await h.client('/mcp/crm',created.body.key))).toEqual(['follow_ups_due','get_deal','pipeline_summary','search_deals']);
    expect((await h.app.inject({method:'POST',url:'/api/mcp-requests',headers:h.headers('member'),payload:{surface:'admin',reason:'x'}})).statusCode).toBe(403);
    const admin=await h.key('admin',{surface:'crm',level:'full'});
    expect(await toolNames(await h.client('/mcp/crm',admin.body.key))).toEqual(['add_note','edit_deal','follow_ups_due','get_deal','move_deal','pipeline_summary','search_deals']);
  });
  it('pins Tasks keys to the workspace owner and keeps read keys read-only',async()=>{
    const h=await setup();
    expect((await h.key('admin',{surface:'tasks',level:'propose'})).status).toBe(400);
    const full=await h.client('/mcp/tasks',(await h.key('admin',{surface:'tasks',level:'full',label:'Hermes'})).body.key);
    const memberId=String((await h.db.query("SELECT id FROM workspace_members WHERE email='member@example.com'")).rows[0]!.id);
    await h.db.query("INSERT INTO personal_tasks(owner_id,title,creation_key) VALUES($1,'Member private task',$2)",[memberId,randomUUID()]);
    const created=await h.call(full,'create_task',{title:'Draft BD plan',dueDate:'2026-01-01'});
    expect(created.value.owner_id).toBe(h.adminId);
    const listed=(await h.call(full,'list_tasks',{})).value.items as {id:string;kind:string;title:string}[];
    expect(listed.map(t=>t.kind).sort()).toEqual(['personal','work']);expect(listed.some(t=>t.title==='Member private task')).toBe(false);
    expect((await h.call(full,'due_today_overdue',{})).value.items.map((t:{id:string})=>t.id)).toContain(created.value.id);
    expect((await h.call(full,'update_task',{id:created.value.id,title:'Draft BD plan v2'})).value.title).toBe('Draft BD plan v2');
    expect((await h.call(full,'update_work_ticket',{id:h.ticketId,nextAction:'Send integration plan',lane:'Work in progress'})).value.moved.lane).toBe('Work in progress');
    expect((await h.db.query('SELECT next_action,lane FROM tickets WHERE id=$1',[h.ticketId])).rows[0]).toEqual({next_action:'Send integration plan',lane:'Work in progress'});
    expect((await h.call(full,'complete_task',{id:created.value.id})).value.lane).toBe('Completed');
    expect((await h.call(full,'delete_task',{id:created.value.id})).value).toEqual({deleted:true});

    const readKey=await h.key('admin',{surface:'tasks',level:'read',memberId});
    expect(readKey.status).toBe(200);
    const read=await h.client('/mcp/tasks',readKey.body.key);
    expect(await toolNames(read)).toEqual(['due_today_overdue','get_task','list_tasks']);
    expect((await h.call(read,'list_tasks',{})).value.items.some((t:{id:string})=>t.id===h.ticketId)).toBe(true);
    expect((await h.call(read,'create_task',{title:'Nope'})).value.error.code).toBe('forbidden');
  });

  it('emails the admin for elevated access, needs an admin session and a single-use unexpired token, then grants it',async()=>{
    const h=await setup();
    expect((await h.app.inject({method:'POST',url:'/api/mcp-requests',headers:h.headers('admin'),payload:{surface:'admin',reason:'x'}})).statusCode).toBe(409);
    const asked=await h.app.inject({method:'POST',url:'/api/mcp-requests',headers:h.headers('member'),payload:{surface:'admin',reason:'Run the weekly CRM digest'}});
    expect(asked.json()).toMatchObject({status:'pending',email:'sent'});
    expect((await h.app.inject({method:'POST',url:'/api/mcp-requests',headers:h.headers('member'),payload:{surface:'admin',reason:'again'}})).statusCode).toBe(409);
    expect(h.mail).toHaveLength(1);expect(h.mail[0]!.to).toBe('ravi@antseed.com');expect(h.mail[0]!.text).toContain('Run the weekly CRM digest');
    const link=new URL(h.mail[0]!.text.match(/Approve: (\S+)/)![1]!);expect(link.pathname).toBe('/mcp-approval');
    const id=link.searchParams.get('id')!,token=link.searchParams.get('token')!;
    expect((await h.app.inject({url:link.pathname+link.search})).headers.location).toBe(`/login?next=${encodeURIComponent(link.pathname+link.search)}`);
    expect((await h.app.inject({url:link.pathname+link.search,headers:h.headers('member')})).statusCode).toBe(403);
    expect((await h.app.inject({method:'POST',url:`/api/mcp-requests/${id}/decision`,headers:h.headers('member'),payload:{action:'approve',token}})).statusCode).toBe(403);
    expect((await h.app.inject({method:'POST',url:`/api/mcp-requests/${id}/decision`,headers:{...h.headers('admin'),origin:'https://evil.example'},payload:{action:'approve',token}})).statusCode).toBe(403);
    expect((await h.app.inject({method:'POST',url:`/api/mcp-requests/${id}/decision`,headers:h.headers('admin'),payload:{action:'approve',token:'x'.repeat(43)}})).statusCode).toBe(403);
    expect((await h.app.inject({method:'POST',url:`/api/mcp-requests/${id}/decision`,headers:h.headers('admin'),payload:{action:'approve',token}})).json()).toMatchObject({status:'approved'});
    expect((await h.app.inject({method:'POST',url:`/api/mcp-requests/${id}/decision`,headers:h.headers('admin'),payload:{action:'deny',token}})).statusCode).toBe(403);
    const adminKey=await h.key('member',{surface:'admin'});expect(adminKey.status).toBe(200);
    expect((await h.key('member',{surface:'admin'})).status).toBe(403); // One key per approval.
    expect((await h.app.inject({method:'POST',url:'/mcp',headers:{authorization:`Bearer ${adminKey.body.key}`},payload:{}})).json()).toEqual({member:'member@example.com',key:'admin'});

    const crm=await h.key('member',{surface:'crm'});
    const upgrade=(await h.app.inject({method:'POST',url:'/api/mcp-requests',headers:h.headers('member'),payload:{surface:'crm',keyId:crm.body.item.id,reason:'Direct edits'}})).json();
    const queued=(await h.app.inject({url:'/api/mcp-requests?status=pending',headers:h.headers('admin')})).json().items;
    expect(queued.map((q:{id:string})=>q.id)).toEqual([upgrade.id]);
    await h.db.query("UPDATE mcp_access_requests SET expires_at=now()-interval '1 minute' WHERE id=$1",[upgrade.id]);
    expect((await h.app.inject({method:'POST',url:`/api/mcp-requests/${upgrade.id}/decision`,headers:h.headers('admin'),payload:{action:'approve'}})).statusCode).toBe(409);
    await h.db.query("UPDATE mcp_access_requests SET expires_at=now()+interval '1 hour' WHERE id=$1",[upgrade.id]);
    expect((await h.app.inject({method:'POST',url:`/api/mcp-requests/${upgrade.id}/decision`,headers:h.headers('admin'),payload:{action:'approve'}})).statusCode).toBe(200);
    expect((await h.db.query('SELECT level FROM mcp_keys WHERE id=$1',[crm.body.item.id])).rows[0]).toEqual({level:'full'});
    expect((await h.db.query("SELECT count(*)::int AS n FROM workspace_audit WHERE action IN ('mcp_request.create','mcp_request.approve')")).rows[0]).toEqual({n:4});
  });

  it('keeps requests visible in Approvals when email is not configured',async()=>{
    const h=await setup(false);
    const asked=(await h.app.inject({method:'POST',url:'/api/mcp-requests',headers:h.headers('member'),payload:{surface:'admin',reason:'Need it'}})).json();
    expect(asked.email).toBe('not_configured');
    const pending=(await h.app.inject({url:'/api/mcp-requests?status=pending',headers:h.headers('admin')})).json();
    expect(pending).toMatchObject({emailConfigured:false,items:[{id:asked.id,email_state:'not_configured',member_email:'member@example.com'}]});
    expect((await h.app.inject({url:'/api/mcp-requests?status=pending',headers:h.headers('member')})).json().items).toHaveLength(1);
    expect((await h.app.inject({url:'/api/mcp-requests?status=pending',headers:h.headers('viewer')})).json().items).toHaveLength(0);
  });
});
