import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { AccessControl } from '../../src/access/service.js';
import { registerBoard } from '../../src/board/routes.js';
import { OutreachWorkflow } from '../../src/outreach/service.js';
import { ProposalRepository } from '../../src/workflow/proposals.js';
import { TelegramStore } from '../../src/telegram/store.js';
import type { PgDatabase } from '../../src/platform/database.js';
import { fixtureDatabase } from '../workflow/database.js';

const names=['202610250001_outreach_core.sql','202610260001_outreach_workflow.sql','202610260002_stable_outreach_sources.sql','202610270004_operator_intake_approvals.sql','202610280001_crm_first.sql','202610290001_native_workspace.sql','202610300001_work_task_ownership.sql','202610310001_ticket_headline.sql'];
const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});

/** Real Fastify routes and local Auth HTTP boundary over an isolated PostgreSQL engine; never touches hosted services. */
async function setup(){
  const db=await fixtureDatabase(names.map(name=>new URL(`../../db/migrations/${name}`,import.meta.url)));cleanup.push(()=>db.close());
  const identities=new Map(['ravi@antseed.com','member@example.com','viewer@example.com','manager@example.com'].map(email=>[email,{id:randomUUID(),email,email_confirmed_at:'2026-10-29T00:00:00Z'}]));
  const provider=Fastify();
  provider.get('/auth/v1/user',async(req,reply)=>identities.get(req.headers.authorization?.replace('Bearer ','')??'')??reply.code(401).send({error:'Invalid token'}));
  provider.get('/auth/v1/.well-known/jwks.json',async()=>({keys:[]}));
  provider.get('/auth/v1/settings',async()=>({mailer_autoconfirm:false}));
  const origin=await provider.listen({host:'127.0.0.1',port:0});cleanup.push(()=>provider.close());
  const access=new AccessControl(db,{supabaseUrl:origin,publishableKey:'synthetic-public-key',adminEmail:'ravi@antseed.com',appUrl:'http://localhost:19490',crmApproval:'direct'});
  const app=await buildApp();cleanup.push(()=>app.close());await access.register(app);app.decorate('workspaceAccess',access);
  const outreach=new OutreachWorkflow(db,{now:()=>new Date()},{provider:'openai',endpoint:'https://api.openai.com/v1/decisions',model:'gpt-6-luna',apiKey:null,timeoutMs:1000,maxAttempts:1},{nativeBoard:true});
  const work=new ProposalRepository(db,{subscribe:()=>()=>{},enqueueProposal:async()=>{}});
  const intake=new TelegramStore(db as unknown as PgDatabase,{apiId:null,apiHash:null,sessionPath:'',historyBatchSize:10,historyMaxBatches:1});
  registerBoard(app,db,outreach,async()=>{},'Asia/Kolkata',{work,intake});
  await access.identify('ravi@antseed.com');
  for(const [key,role] of [['member','member'],['viewer','viewer'],['manager','crm_manager']] as const){
    await db.query('INSERT INTO workspace_members(email,role) VALUES($1,$2)',[`${key}@example.com`,role]);await access.identify(`${key}@example.com`);
  }
  const headers=(who:string)=>({authorization:`Bearer ${who==='admin'?'ravi@antseed.com':who+'@example.com'}`});
  // An accepted CRM relationship with one approved Work ticket, built through the real placement and approval routes.
  await outreach.reconcile();const unplaced=(await outreach.listReviewRelationships({})).items[0]!;
  expect((await app.inject({method:'POST',url:`/api/board/approvals/relationships/${unplaced.id}/place`,headers:headers('manager'),
    payload:{targetStage:'lead',expectedEvidenceRevision:unplaced.evidenceRevision,idempotencyKey:randomUUID(),reason:'Synthetic placement'}})).statusCode).toBe(200);
  const placed=(await outreach.get(unplaced.id)).relationship;
  const proposal=await outreach.proposeWork({relationshipId:placed.id,chatId:'-1001',expectedEvidenceRevision:placed.evidenceRevision,action:'Prepare the integration plan',reason:'Synthetic Work',idempotencyKey:randomUUID()});
  expect((await app.inject({method:'POST',url:`/api/board/approvals/proposals/${proposal.id}/decision`,headers:headers('manager'),payload:{action:'approve',reason:'ok',idempotencyKey:randomUUID()}})).statusCode).toBe(200);
  const ticket=(await db.query('SELECT * FROM tickets WHERE crm_relationship_id=$1',[placed.id])).rows[0]!;
  return {db,app,outreach,headers,relationshipId:placed.id,ticketId:String(ticket.id)};
}

describe('direct Work and CRM edits and deletes (local SQL engine, synthetic Auth)',()=>{
  it('lets CRM managers edit Work fields and rejects stale, cross-site or unauthorized edits',async()=>{
    const h=await setup();const url=`/api/board/work/${h.ticketId}`;
    const peopleResponse=await h.app.inject({url:'/api/board/people',headers:h.headers('viewer')});const people=peopleResponse.json().items as {id:string;name:string}[];
    const owner=people.find(p=>p.name==='member')!;
    const payload={headline:'Integration plan for Cedar',nextAction:'Send the integration plan',summary:'Human notes',workstream:'Integration',
      followUpAt:'2026-11-05T09:30:00.000Z',etaAt:null,ownerId:owner.id,expectedActionsVersion:0};
    expect((await h.app.inject({method:'PATCH',url,headers:h.headers('member'),payload})).statusCode).toBe(403);
    expect((await h.app.inject({method:'PATCH',url,headers:{...h.headers('manager'),origin:'https://evil.example'},payload})).statusCode).toBe(403);
    const saved=await h.app.inject({method:'PATCH',url,headers:h.headers('manager'),payload});
    expect(saved.statusCode).toBe(200);expect(saved.json().actionsVersion).toBe(1);
    expect((await h.app.inject({method:'PATCH',url,headers:h.headers('manager'),payload})).statusCode).toBe(409);
    const row=(await h.db.query('SELECT headline,next_action,summary,workstream,owner_id,actions_source,follow_up_at FROM tickets WHERE id=$1',[h.ticketId])).rows[0]!;
    expect(row).toMatchObject({headline:'Integration plan for Cedar',next_action:'Send the integration plan',summary:'Human notes',workstream:'Integration',owner_id:owner.id,actions_source:'manual'});
    expect(new Date(row.follow_up_at as string).toISOString()).toBe('2026-11-05T09:30:00.000Z');
    const detail=(await h.app.inject({url:`${url}/detail`,headers:h.headers('viewer')})).json();
    expect(detail.title).toBe('Integration plan for Cedar');
    expect(detail.history[0]).toMatchObject({action:'work.update'});
    const team=(await h.app.inject({url:'/api/board/tasks?scope=team',headers:h.headers('viewer')})).json().items;
    expect(team.find((t:{id:string})=>t.id===h.ticketId)).toMatchObject({title:'Integration plan for Cedar',actions_version:1});
    expect((await h.app.inject({method:'PATCH',url,headers:h.headers('manager'),payload:{...payload,workstream:'Unknown',expectedActionsVersion:1}})).statusCode).toBe(400);
  });

  it('deletes a Work ticket with its proposals and links, keeps its conversation facts, and audits who did it',async()=>{
    const h=await setup();const url=`/api/board/work/${h.ticketId}`;
    const job=(await h.db.query("INSERT INTO analysis_jobs(chat_id,policy_version,mapping_version,dedupe_key,status) VALUES(-1001,0,0,'fixture-delete','completed') RETURNING id")).rows[0]!;
    await h.db.query("INSERT INTO facts(job_id,ticket_id,kind,text) VALUES($1,$2,'action','Synthetic fact')",[job.id,h.ticketId]);
    const p=(await h.db.query(`INSERT INTO proposals(ticket_id,source_lane,source_stage_version,source_mapping_version,source_policy_version,target_lane,reason,origin)
      VALUES($1,'To be started',0,0,0,'Work in progress','Synthetic pending move','manual') RETURNING id`,[h.ticketId])).rows[0]!;
    expect((await h.app.inject({method:'DELETE',url,headers:h.headers('member'),payload:{expectedActionsVersion:0}})).statusCode).toBe(403);
    expect((await h.app.inject({method:'DELETE',url,headers:h.headers('manager'),payload:{expectedActionsVersion:7}})).statusCode).toBe(409);
    expect((await h.app.inject({method:'DELETE',url,headers:h.headers('manager'),payload:{expectedActionsVersion:0}})).json()).toEqual({deleted:true});
    expect((await h.db.query('SELECT 1 FROM tickets WHERE id=$1',[h.ticketId])).rowCount).toBe(0);
    expect((await h.db.query('SELECT 1 FROM proposals WHERE id=$1',[p.id])).rowCount).toBe(0);
    expect((await h.db.query("SELECT ticket_id FROM facts WHERE text='Synthetic fact'")).rows[0]).toEqual({ticket_id:null});
    expect((await h.db.query("SELECT action,before_value->>'nextAction' AS next FROM workspace_audit WHERE resource_id=$1 AND action='work.delete'",[h.ticketId])).rows[0]).toEqual({action:'work.delete',next:'Prepare the integration plan'});
    expect((await h.outreach.get(h.relationshipId)).relationship.acceptedStage).toBe('lead');
    expect((await h.app.inject({url:`${url}/detail`,headers:h.headers('viewer')})).statusCode).toBe(404);
  });

  it('edits CRM name, notes, workstream and follow-up directly, and reconciliation keeps them',async()=>{
    const h=await setup();const url=`/api/board/crm/${h.relationshipId}`;
    const before=(await h.outreach.get(h.relationshipId)).relationship;
    const payload={displayName:'Cedar Labs (pilot)',summary:'Warm intro via Devcon',workstream:'Buyer',nextAction:'Send pilot terms',followUpDate:'2026-11-07',expectedEvidenceRevision:before.evidenceRevision};
    expect((await h.app.inject({method:'PATCH',url,headers:h.headers('viewer'),payload})).statusCode).toBe(403);
    expect((await h.app.inject({method:'PATCH',url,headers:h.headers('manager'),payload:{...payload,expectedEvidenceRevision:before.evidenceRevision+5}})).statusCode).toBe(409);
    expect((await h.app.inject({method:'PATCH',url,headers:h.headers('admin'),payload})).statusCode).toBe(200);
    await h.outreach.reconcile();
    const detail=(await h.app.inject({url:`${url}/detail`,headers:h.headers('viewer')})).json();
    expect(detail.relationship).toMatchObject({displayName:'Cedar Labs (pilot)',summary:'Warm intro via Devcon',workstream:'Buyer',acceptedStage:'lead',nextStep:'Next: Send pilot terms · ETA: 2026-11-07'});
    expect(detail.history[0]).toMatchObject({action:'crm.update'});
    const current=detail.relationship.evidenceRevision;
    expect((await h.app.inject({method:'PATCH',url,headers:h.headers('admin'),payload:{...payload,nextAction:null,followUpDate:null,expectedEvidenceRevision:current}})).statusCode).toBe(200);
    expect((await h.db.query("SELECT state FROM outreach_actions WHERE relationship_id=$1",[h.relationshipId])).rows).toEqual([{state:'cancelled'}]);
  });

  it('deletes a CRM relationship completely, with its Work, and keeps reconciliation from recreating it',async()=>{
    const h=await setup();const url=`/api/board/crm/${h.relationshipId}`;
    const revision=(await h.outreach.get(h.relationshipId)).relationship.evidenceRevision;
    expect((await h.app.inject({method:'DELETE',url,headers:h.headers('member'),payload:{expectedEvidenceRevision:revision}})).statusCode).toBe(403);
    const result=await h.app.inject({method:'DELETE',url,headers:h.headers('manager'),payload:{expectedEvidenceRevision:revision}});
    expect(result.statusCode).toBe(200);expect(result.json()).toEqual({deleted:true,workTickets:1,excludedChats:1});
    for(const [table,column] of [['outreach_relationships','id'],['outreach_relationship_sources','relationship_id'],['outreach_sales_proposals','relationship_id']] as const)
      expect((await h.db.query(`SELECT 1 FROM ${table} WHERE ${column}=$1`,[h.relationshipId])).rowCount).toBe(0);
    expect((await h.db.query('SELECT 1 FROM tickets WHERE id=$1',[h.ticketId])).rowCount).toBe(0);
    expect((await h.db.query('SELECT inclusion FROM chats WHERE id=-1001')).rows[0]).toEqual({inclusion:'excluded'});
    expect((await h.db.query("SELECT 1 FROM workspace_audit WHERE resource_id=$1 AND action='crm.delete'",[h.relationshipId])).rowCount).toBe(1);
    await h.outreach.reconcile();
    expect((await h.db.query('SELECT count(*)::int AS n FROM outreach_relationships')).rows[0]).toEqual({n:0});
    expect((await h.app.inject({url:'/api/outreach/relationships',headers:h.headers('viewer')})).statusCode).not.toBe(500);
  });
});
