import { TelegramStore } from '../../src/telegram/store.js';
import { initializeWorkOwner } from '../../src/board/ownership.js';
import { ChatIntake } from '../../src/telegram/intake.js';
import type { PgDatabase } from '../../src/platform/database.js';
import type { TelegramPort } from '../../src/shared/ports.js';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { AccessControl } from '../../src/access/service.js';
import { registerBoard } from '../../src/board/routes.js';
import { OutreachWorkflow } from '../../src/outreach/service.js';
import { NativeProposalWorkflow } from '../../src/board/native-workflow.js';
import { ProposalRepository } from '../../src/workflow/proposals.js';
import { fixtureDatabase } from '../workflow/database.js';
import type { Member } from '../../src/access/service.js';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { registerMcp } from '../../src/hermes/mcp.js';

const names=['202610250001_outreach_core.sql','202610260001_outreach_workflow.sql','202610260002_stable_outreach_sources.sql','202610270004_operator_intake_approvals.sql','202610280001_crm_first.sql','202610290001_native_workspace.sql','202610300001_work_task_ownership.sql','202610310001_ticket_headline.sql'];
const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function setup(){
  const db=await fixtureDatabase(names.map(name=>new URL(`../../db/migrations/${name}`,import.meta.url)));cleanup.push(()=>db.close());
  const identities=new Map<string,{id:string;email:string;email_confirmed_at:string|null}>();
  for(const email of ['ravi@antseed.com','member@example.com','other@example.com','viewer@example.com','manager@example.com','intruder@example.com'])
    identities.set(email,{id:randomUUID(),email,email_confirmed_at:'2026-10-29T00:00:00Z'});
  let providerFailure=false;
  let userRequests=0;
  const keys=await generateKeyPair('ES256'),jwk={...await exportJWK(keys.publicKey),kid:'synthetic-jwt-key',alg:'ES256',use:'sig'};
  // Real HTTP boundary, synthetic Supabase responses; never calls hosted Auth.
  const provider=Fastify();provider.get('/auth/v1/user',async(req,reply)=>{
    userRequests++;
    if(providerFailure)return reply.code(503).send({error:'Synthetic provider outage'});
    const user=identities.get(req.headers.authorization?.replace('Bearer ','')??'');
    return user??reply.code(401).send({error:'Invalid token'});
  });
  provider.get('/auth/v1/.well-known/jwks.json',async()=>({keys:[jwk]}));
  provider.get('/auth/v1/settings',async()=>({mailer_autoconfirm:false}));
  provider.post('/auth/v1/token',async(req,reply)=>{
    const input=req.body as {email?:string;password?:string;refresh_token?:string};
    const email=input.email??input.refresh_token;
    if(!email||!identities.has(email)||input.password==='wrong')return reply.code(400).send({error:'Invalid credentials'});
    return {access_token:email,refresh_token:email,expires_in:3600};
  });
  provider.post('/auth/v1/signup',async()=>({user:{id:randomUUID()}}));
  provider.post('/auth/v1/logout',async(_req,reply)=>reply.code(204).send());
  const origin=await provider.listen({host:'127.0.0.1',port:0});cleanup.push(()=>provider.close());
  const access=new AccessControl(db,{supabaseUrl:origin,publishableKey:'synthetic-public-key',adminEmail:'ravi@antseed.com',appUrl:'http://localhost:19490',crmApproval:'direct'});
  const app=await buildApp();cleanup.push(()=>app.close());await access.register(app);app.decorate('workspaceAccess',access);
  const outreach=new OutreachWorkflow(db,{now:()=>new Date()},{provider:'openai',endpoint:'https://api.openai.com/v1/decisions',model:'gpt-6-luna',apiKey:null,timeoutMs:1000,maxAttempts:1},{nativeBoard:true});
  const work=new ProposalRepository(db,{subscribe:()=>()=>{},enqueueProposal:async()=>{}});
  const intake=new TelegramStore(db as unknown as PgDatabase,{apiId:null,apiHash:null,sessionPath:'',historyBatchSize:10,historyMaxBatches:1});
  registerBoard(app,db,outreach,async()=>{},'Asia/Kolkata',{work,intake});
  app.get('/api/outreach/relationships',async()=>outreach.list({}));
  app.get('/api/outreach/relationships/:id',async req=>outreach.get((req.params as {id:string}).id));
  app.get('/api/outreach/proposals',async()=>outreach.listProposals({}));
  app.post('/api/outreach/proposals',async()=>({unexpected:'legacy write'}));
  const mcp=registerMcp(app,{},async()=>{},work=>work(),[]);cleanup.push(()=>mcp.close());
  const members:Record<string,Member>={};
  members.admin=await access.identify('ravi@antseed.com');
  const bootstrapTelegramId=(await db.query('SELECT telegram_user_id FROM workspace_members WHERE id=$1',[members.admin.id])).rows[0]!.telegram_user_id;
  // A test identity is linked explicitly. Production never infers a person's
  // Telegram identity from the workspace's ingestion account.
  await db.query('UPDATE workspace_members SET telegram_user_id=99 WHERE id=$1',[members.admin.id]);
  for(const [key,role]of [['member','member'],['other','member'],['viewer','viewer'],['manager','crm_manager']]as const){
    await db.query('INSERT INTO workspace_members(email,role) VALUES($1,$2)',[`${key}@example.com`,role]);members[key]=await access.identify(`${key}@example.com`);
  }
  const headers=(who='member')=>({authorization:`Bearer ${who==='admin'?'ravi@antseed.com':who+'@example.com'}`});
  const task=(title='Personal task')=>({title,description:'Synthetic task',lane:'To be started',dueDate:'2026-11-04',idempotencyKey:randomUUID()});
  const sign=async(who='member',options:{issuer?:string;audience?:string;expires?:string}={})=>new SignJWT({email:`${who}@example.com`,user_metadata:{role:'admin'}})
    .setProtectedHeader({alg:'ES256',kid:'synthetic-jwt-key'}).setSubject(identities.get(`${who}@example.com`)!.id)
    .setIssuer(options.issuer??`${origin}/auth/v1`).setAudience(options.audience??'authenticated').setIssuedAt().setExpirationTime(options.expires??'5m').sign(keys.privateKey);
  return {db,app,access,outreach,work,intake,members,headers,task,identities,sign,bootstrapTelegramId,userRequests:()=>userRequests,failProvider:()=>{providerFailure=true;}};
}
describe('native workspace permissions (real local Auth HTTP, isolated PostgreSQL engine)',()=>{
  it('assigns existing generated Work once, defaults future Work to Ravi, and includes both task types in My tasks',async()=>{
    const h=await setup();
    const legacy=(await h.db.query("INSERT INTO tickets(chat_id,kind,summary,next_action,owner_id) VALUES(-1001,'contact_prospect','Existing generated work','Send the revised pricing agreement to the partner today',NULL) RETURNING id")).rows[0]!;
    await h.db.query("INSERT INTO chats(id,kind,title,inclusion) VALUES(44,'user','Future Work','included'),(45,'user','Other owner','included')");
    await h.db.query("INSERT INTO chat_intake_requests(chat_id,policy_version,decision,decision_origin,operator_reason,decided_at) VALUES(44,0,'approved','operator','Synthetic consent',now()),(45,0,'approved','operator','Synthetic consent',now())");
    const other=(await h.db.query("INSERT INTO tickets(chat_id,kind,summary,next_action,owner_id) VALUES(45,'contact_prospect','Assigned to another member','Share logs',$1) RETURNING id",[h.members.other!.id])).rows[0]!;
    expect(await h.db.transaction(tx=>initializeWorkOwner(tx,h.members.admin!.id))).toBe(1);
    expect(await h.db.transaction(tx=>initializeWorkOwner(tx,h.members.admin!.id))).toBe(0);
    const future=(await h.db.query("INSERT INTO tickets(chat_id,kind,summary,next_action) VALUES(44,'contact_prospect','Future generated work','Follow up') RETURNING id,owner_id")).rows[0]!;
    expect(future.owner_id).toBe(h.members.admin!.id);
    await h.db.transaction(async tx=>{await tx.query('SET LOCAL search_path TO pg_catalog');expect((await tx.query('SELECT public.workspace_default_work_owner() AS owner')).rows[0]!.owner).toBe(h.members.admin!.id);});
    expect((await h.db.query('SELECT owner_id FROM tickets WHERE id=$1',[other.id])).rows[0]!.owner_id).toBe(h.members.other!.id);
    const personal=(await h.app.inject({method:'POST',url:'/api/board/tasks',headers:h.headers('admin'),payload:h.task('Ravi personal task')})).json();
    await h.app.inject({method:'POST',url:'/api/board/tasks',headers:h.headers(),payload:h.task('Member personal task')});
    const mine=(await h.app.inject({url:'/api/board/tasks?scope=mine',headers:h.headers('admin')})).json().items;
    expect(mine.map((t:{id:string})=>t.id).sort()).toEqual([legacy.id,future.id,personal.id].sort());
    expect(mine.filter((t:{kind:string})=>t.kind==='work')).toHaveLength(2);
    expect(mine.find((t:{id:string})=>t.id===legacy.id)).toMatchObject({company:expect.any(String),title:'Send revised pricing agreement'});
    const first=(await h.app.inject({url:'/api/board/tasks?scope=mine&limit=1',headers:h.headers('admin')})).json();
    const next=(await h.app.inject({url:'/api/board/tasks?scope=mine&limit=2&cursor='+first.nextCursor,headers:h.headers('admin')})).json();
    expect(new Set([...first.items,...next.items].map((t:{id:string})=>t.id)).size).toBe(3);expect(next.nextCursor).toBeNull();
    expect((await h.app.inject({url:'/api/board/tasks?scope=mine',headers:h.headers('other')})).json().items.map((t:{id:string})=>t.id)).toEqual([other.id]);
    expect((await h.app.inject({url:'/api/board/tasks?scope=team',headers:h.headers('viewer')})).json().items).toHaveLength(5);
    expect((await h.app.inject({url:`/api/board/work/${legacy.id}/detail`,headers:h.headers('admin')})).json().metadata).toMatchObject({owner_id:h.members.admin!.id,owner_name:'ravi'});
    expect((await h.db.query("SELECT * FROM workspace_audit WHERE action='work.assign'")).rowCount).toBe(1);
    await h.db.query("UPDATE chats SET inclusion='excluded' WHERE id=44");
    expect((await h.app.inject({url:'/api/board/tasks?scope=mine',headers:h.headers('admin')})).json().items).toHaveLength(2);
  });
  it('keeps unplaced CRM records private to Approvals, including guessed detail URLs and paginated queues',async()=>{
    const h=await setup();await h.outreach.reconcile();const r=(await h.outreach.listReviewRelationships({})).items[0]!;
    for(const who of ['admin','manager','member','viewer']){
      expect((await h.app.inject({url:'/api/outreach/relationships',headers:h.headers(who)})).json().items).toEqual([]);
      expect((await h.app.inject({url:'/api/outreach/relationships/'+r.id,headers:h.headers(who)})).statusCode).toBe(404);
    }
    for(const who of ['member','viewer'])for(const url of ['/api/board/approvals/placements','/api/board/approvals/relationships/'+r.id,'/api/board/approvals/proposals','/api/board/approvals/work','/api/board/approvals/intake','/api/outreach/proposals'])
      expect((await h.app.inject({url,headers:h.headers(who)})).statusCode).toBe(403);
    const privateQueue=await h.app.inject({url:'/api/board/approvals/placements?limit=1',headers:h.headers('manager')});
    expect(privateQueue.statusCode).toBe(200);expect(privateQueue.json().items[0].id).toBe(r.id);
    expect((await h.app.inject({url:'/api/board/approvals/relationships/'+r.id,headers:h.headers('manager')})).statusCode).toBe(200);
    expect((await h.app.inject({method:'POST',url:`/api/board/crm/${r.id}/move`,headers:h.headers('admin'),payload:{targetStage:'lead',expectedEvidenceRevision:r.evidenceRevision,idempotencyKey:'bypass',reason:'Wrong surface'}})).statusCode).toBe(409);
    await h.outreach.moveByHuman({relationshipId:r.id,targetStage:'lead',expectedEvidenceRevision:r.evidenceRevision,idempotencyKey:'place-private',reason:'Reviewed in Approvals'},h.members.manager!,'unplaced');
    expect((await h.app.inject({url:'/api/outreach/relationships',headers:h.headers('viewer')})).json().items[0].id).toBe(r.id);
    expect((await h.app.inject({url:'/api/board/approvals/placements',headers:h.headers('manager')})).json().items).toEqual([]);
    expect((await h.app.inject({url:'/api/outreach/relationships/'+r.id,headers:h.headers('viewer')})).statusCode).toBe(200);
    await h.db.query("INSERT INTO chats(id,kind,title,inclusion) VALUES(44,'user','Pending A','included'),(45,'user','Pending B','included')");
    await h.db.query("INSERT INTO chat_intake_requests(chat_id,policy_version,decision,decision_origin,operator_reason,decided_at) VALUES(44,0,'approved','operator','Synthetic consent',now()),(45,0,'approved','operator','Synthetic consent',now())");
    await h.outreach.reconcile();
    const first=await h.outreach.listReviewRelationships({limit:1});expect(first.items).toHaveLength(1);expect(first.nextCursor).not.toBeNull();
    const second=await h.outreach.listReviewRelationships({limit:1,cursor:first.nextCursor!});expect(second.items).toHaveLength(1);expect(second.nextCursor).toBeNull();
    expect(first.items[0]!.id).not.toBe(second.items[0]!.id);
    expect((await h.outreach.list({limit:1})).items.map(x=>x.id)).toEqual([r.id]);
    expect((await h.outreach.list({limit:1})).nextCursor).toBeNull();
    const target=first.items[0]!,other=second.items[0]!;
    const pending=await h.outreach.propose({relationshipId:target.id,expectedEvidenceRevision:target.evidenceRevision,targetStage:'qualification',reason:'Independent review',idempotencyKey:'independent-ai'},'openai');
    const before=(await h.outreach.manifest(h.db,target.id)).hash;
    await h.outreach.moveByHuman({relationshipId:other.id,expectedEvidenceRevision:other.evidenceRevision,targetStage:'lead',reason:'Unrelated initial placement',idempotencyKey:'independent-placement'},h.members.manager!,'unplaced');
    expect((await h.outreach.manifest(h.db,target.id)).hash).toBe(before);
    expect((await h.app.inject({method:'POST',url:`/api/board/approvals/proposals/${pending.id}/decision`,headers:h.headers('manager'),payload:{action:'approve',reason:'Reviewed independently',idempotencyKey:'independent-approve'}})).statusCode).toBe(200);
  });
  it('approves AI suggestions on the web once and ignores the later Telegram reply',async()=>{
    const h=await setup();await h.outreach.reconcile();const r=(await h.outreach.listReviewRelationships({})).items[0]!;
    await h.db.query("INSERT INTO chats(id,kind,title,inclusion,is_control) VALUES(-999,'supergroup','Synthetic approvals','excluded',true)");
    const p=await h.outreach.propose({relationshipId:r.id,expectedEvidenceRevision:r.evidenceRevision,targetStage:'qualification',idempotencyKey:'web-ai',reason:'Synthetic AI suggestion'},'openai');
    await h.db.query("UPDATE outreach_control_outbox SET chat_id=-999,message_id=700,state='sent' WHERE proposal_id=$1",[p.id]);
    const pending=(await h.app.inject({url:'/api/board/approvals/proposals',headers:h.headers('manager')})).json().items[0];
    expect(pending).toMatchObject({id:p.id,origin:'openai',state:'pending'});expect(pending).not.toHaveProperty('context');expect(pending).not.toHaveProperty('manifest');
    const url=`/api/board/approvals/proposals/${p.id}/decision`,payload={action:'approve',reason:'Reviewed evidence',idempotencyKey:'web-approve'};
    expect((await h.app.inject({method:'POST',url,headers:h.headers(),payload})).statusCode).toBe(403);
    const approve=await h.app.inject({method:'POST',url,headers:h.headers('manager'),payload});expect(approve.statusCode).toBe(200);
    expect((await h.app.inject({method:'POST',url,headers:h.headers('manager'),payload})).json().id).toBe(approve.json().id);
    expect((await h.app.inject({method:'POST',url,headers:h.headers('admin'),payload})).statusCode).toBe(409);
    await h.outreach.handleControlReply({chatId:'-999',messageId:701,senderId:'99',replyToMessageId:700,text:'approve',sentAt:new Date().toISOString()});
    expect((await h.outreach.get(r.id)).relationship).toMatchObject({acceptedStage:'qualification',stageVersion:1});
    expect((await h.db.query('SELECT * FROM outreach_sales_decisions')).rowCount).toBe(1);
    expect((await h.outreach.listProposals({relationshipId:r.id})).items[0]).toMatchObject({human_move:false,decision_source:'http'});
    expect((await h.db.query("SELECT * FROM workspace_audit WHERE action='crm.approval'")).rowCount).toBe(1);
    expect((await h.app.inject({url:'/api/board/approvals/proposals',headers:h.headers('manager')})).json().items).toEqual([]);
    const current=(await h.outreach.get(r.id)).relationship;
    const work=await h.outreach.proposeWork({relationshipId:r.id,chatId:'-1001',expectedEvidenceRevision:current.evidenceRevision,action:'Prepare the integration plan',reason:'Explicit reviewed Work',idempotencyKey:'work-create-web'});
    expect((await h.app.inject({method:'POST',url:`/api/board/approvals/proposals/${work.id}/decision`,headers:h.headers('manager'),payload:{action:'approve',reason:'Concrete action approved',idempotencyKey:'work-create-decision'}})).statusCode).toBe(200);
    expect((await h.db.query('SELECT crm_relationship_id,creation_proposal_id,lane FROM tickets')).rows).toEqual([{crm_relationship_id:r.id,creation_proposal_id:work.id,lane:'To be started'}]);
  });
  it('never queues or creates the same approval twice',async()=>{
    const h=await setup();await h.outreach.reconcile();const r=(await h.outreach.listReviewRelationships({})).items[0]!;
    const stage=()=>h.outreach.propose({relationshipId:r.id,expectedEvidenceRevision:r.evidenceRevision,targetStage:'qualification',idempotencyKey:randomUUID(),reason:'Synthetic AI suggestion'},'openai');
    const first=await stage();expect((await stage()).id).toBe(first.id);
    expect((await h.app.inject({url:'/api/board/approvals/proposals',headers:h.headers('manager')})).json().items).toHaveLength(1);
    expect((await h.app.inject({method:'POST',url:`/api/board/approvals/proposals/${first.id}/decision`,headers:h.headers('manager'),payload:{action:'approve',reason:'ok',idempotencyKey:'dedupe-stage'}})).statusCode).toBe(200);
    const current=(await h.outreach.get(r.id)).relationship;
    const work=(action:string)=>h.outreach.proposeWork({relationshipId:r.id,chatId:'-1001',expectedEvidenceRevision:current.evidenceRevision,action,reason:'Explicit reviewed Work',idempotencyKey:randomUUID()});
    const a=await work('Prepare the integration plan');expect((await work('  prepare the INTEGRATION plan ')).id).toBe(a.id);
    expect((await work('Send the pricing sheet')).id).not.toBe(a.id);
    expect((await h.app.inject({url:'/api/board/approvals/proposals',headers:h.headers('manager')})).json().items).toHaveLength(2);
    await h.db.query("INSERT INTO outreach_sales_proposals(relationship_id,idempotency_key,command_hash,target_stage,reason,origin,manifest,input_hash,context,command_kind,command_payload) SELECT relationship_id,'forced-dupe',command_hash,target_stage,reason,origin,manifest,input_hash,context,command_kind,command_payload FROM outreach_sales_proposals WHERE id=$1",[a.id]);
    const dupe=(await h.db.query("SELECT id FROM outreach_sales_proposals WHERE idempotency_key='forced-dupe'")).rows[0]!;
    for(const id of [a.id,dupe.id])expect((await h.app.inject({method:'POST',url:`/api/board/approvals/proposals/${id}/decision`,headers:h.headers('manager'),payload:{action:'approve',reason:'ok',idempotencyKey:'dedupe-'+id}})).statusCode).toBe(200);
    expect((await h.db.query("SELECT 1 FROM tickets WHERE crm_relationship_id=$1 AND next_action='Prepare the integration plan'",[r.id])).rowCount).toBe(1);
  });
  it('keeps rejected and corrected initial placements hidden and rejects stale web decisions',async()=>{
    const h=await setup();await h.outreach.reconcile();const r=(await h.outreach.listReviewRelationships({})).items[0]!;
    const propose=(key:string)=>h.outreach.propose({relationshipId:r.id,expectedEvidenceRevision:r.evidenceRevision,targetStage:'lead',idempotencyKey:key,reason:'Synthetic suggestion'},'openai');
    const reject=await propose('reject-fixture');
    expect((await h.app.inject({method:'POST',url:`/api/board/approvals/proposals/${reject.id}/decision`,headers:h.headers('manager'),payload:{action:'reject',reason:'Insufficient context',idempotencyKey:'reject-key'}})).statusCode).toBe(200);
    const correct=await propose('correct-fixture');
    const result=await h.app.inject({method:'POST',url:`/api/board/approvals/proposals/${correct.id}/decision`,headers:h.headers('manager'),payload:{action:'correct',correctedStage:'qualification',reason:'Review a different stage',idempotencyKey:'correct-key'}});
    expect(result.statusCode).toBe(200);expect((await h.outreach.getProposal(result.json().replacement_id)).state).toBe('pending');
    expect((await h.outreach.list({})).items).toEqual([]);
    await h.db.query('UPDATE outreach_relationships SET evidence_revision=evidence_revision+1 WHERE id=$1',[r.id]);
    expect((await h.app.inject({method:'POST',url:`/api/board/approvals/proposals/${result.json().replacement_id}/decision`,headers:h.headers('manager'),payload:{action:'approve',reason:'Outdated',idempotencyKey:'stale-key'}})).statusCode).toBe(409);
    expect((await h.outreach.get(r.id)).relationship.acceptedStage).toBeNull();
  });
  it('queues approved Work for native application and prevents Telegram from applying it twice',async()=>{
    const h=await setup();await h.db.query("UPDATE app_settings SET value='{}' WHERE key='workflow:crm-first'");
    await h.db.query("INSERT INTO tickets(chat_id,kind) VALUES(-1001,'contact_prospect')");
    const ticket=(await h.db.query('SELECT id FROM tickets')).rows[0]!;
    const e=(await h.db.query("INSERT INTO evidence(chat_id,message_id,message_version,excerpt,observed_at) VALUES(-1001,1,1,'Synthetic evidence',now()) RETURNING id")).rows[0]!;
    const p=await h.work.propose({ticketId:String(ticket.id),expectedStageVersion:0,targetLane:'Work in progress',evidenceIds:[String(e.id)],reason:'Synthetic Work',nextAction:null,idempotencyKey:'work-web',origin:'openai'});
    const url=`/api/board/approvals/work/${p.id}/decision`,payload={action:'approve',reason:'Ready to proceed',idempotencyKey:'work-approve'};
    expect((await h.app.inject({url:'/api/board/approvals/work',headers:h.headers('manager')})).json().items[0].id).toBe(p.id);
    expect((await h.app.inject({method:'POST',url,headers:h.headers('manager'),payload})).json().proposal.applyState).toBe('queued');
    expect((await h.app.inject({method:'POST',url,headers:h.headers('manager'),payload})).statusCode).toBe(200);
    expect((await h.app.inject({method:'POST',url,headers:h.headers('manager'),payload:{...payload,action:'reject',idempotencyKey:'late-reject'}})).statusCode).toBe(409);
    await h.db.query("INSERT INTO chats(id,kind,title,inclusion,is_control) VALUES(-999,'supergroup','Synthetic control','excluded',true)");
    await h.db.query("INSERT INTO control_outbox(proposal_id,chat_id,random_id,text,message_id,state) VALUES($1,-999,555,'Synthetic receipt',800,'sent')",[p.id]);
    await h.work.handleControlReply({chatId:'-999',messageId:801,senderId:'99',replyToMessageId:800,text:'approve',sentAt:new Date().toISOString()});
    const native=new NativeProposalWorkflow(h.work);await native.applyNext();await native.applyNext();
    expect((await h.db.query('SELECT lane,stage_version FROM tickets')).rows[0]).toEqual({lane:'Work in progress',stage_version:1});
    expect((await h.db.query("SELECT * FROM workspace_audit WHERE action='work.approval'")).rowCount).toBe(1);
  });
  it('lets only admins admit chat intake from the tab, preserving operator proof and creating no Work ticket',async()=>{
    const h=await setup();
    await h.db.query("INSERT INTO chats(id,kind,title,inclusion) VALUES(44,'user','Synthetic intake','undecided')");
    const request=(await h.db.query('INSERT INTO chat_intake_requests(chat_id,policy_version) VALUES(44,0) RETURNING id')).rows[0]!;
    const url=`/api/board/approvals/intake/${request.id}/decision`,payload={action:'approve',reason:'Known CRM conversation',idempotencyKey:'intake-approve'};
    expect((await h.app.inject({url:'/api/board/approvals/intake',headers:h.headers('manager')})).statusCode).toBe(403);
    expect((await h.app.inject({method:'POST',url,headers:h.headers('manager'),payload})).statusCode).toBe(403);
    expect((await h.app.inject({url:'/api/board/approvals/intake',headers:h.headers('admin')})).json().items[0].title).toBe('Synthetic intake');
    expect((await h.app.inject({method:'POST',url,headers:h.headers('admin'),payload})).json().inclusion).toBe('included');
    expect((await h.app.inject({method:'POST',url,headers:h.headers('admin'),payload})).statusCode).toBe(200);
    await h.db.query("INSERT INTO chats(id,kind,title,inclusion,is_control) VALUES(-999,'supergroup','Synthetic control','excluded',true)");
    await h.db.query("UPDATE chat_intake_requests SET control_chat_id=-999,message_id=900 WHERE id=$1",[request.id]);
    const telegramIntake=new ChatIntake(h.db as unknown as PgDatabase,h.intake,{} as TelegramPort,true);
    expect(await telegramIntake.handle({chatId:'-999',messageId:901,senderId:'99',replyToMessageId:900,text:'reject',sentAt:new Date().toISOString()})).toBe(true);
    expect((await h.db.query('SELECT inclusion FROM chats WHERE id=44')).rows[0]!.inclusion).toBe('included');
    expect((await h.db.query('SELECT * FROM tickets WHERE chat_id=44')).rowCount).toBe(0);
    expect((await h.db.query('SELECT decision,decision_origin FROM chat_intake_requests WHERE id=$1',[request.id])).rows[0]).toEqual({decision:'approved',decision_origin:'operator'});
    expect((await h.db.query("SELECT * FROM workspace_audit WHERE action='intake.approval'")).rowCount).toBe(1);
    await h.db.query("INSERT INTO chats(id,kind,title,inclusion) VALUES(45,'user','Second intake','undecided')");
    const second=(await h.db.query("INSERT INTO chat_intake_requests(chat_id,policy_version,control_chat_id,message_id,delivery_state) VALUES(45,0,-999,902,'sent') RETURNING id")).rows[0]!;
    const reply={chatId:'-999',messageId:903,senderId:'7',replyToMessageId:902,text:'approve',sentAt:new Date().toISOString()};
    await telegramIntake.handle(reply);expect((await h.db.query('SELECT decision FROM chat_intake_requests WHERE id=$1',[second.id])).rows[0]!.decision).toBe('pending');
    await telegramIntake.handle({...reply,messageId:904,senderId:'99'});
    expect((await h.db.query('SELECT decision FROM chat_intake_requests WHERE id=$1',[second.id])).rows[0]!.decision).toBe('approved');
    expect((await h.app.inject({method:'POST',url:`/api/board/approvals/intake/${second.id}/decision`,headers:h.headers('admin'),payload:{...payload,idempotencyKey:'after-telegram'}})).statusCode).toBe(409);
  });
  it('requires a verified, invited account and never grants admin to the first arbitrary user',async()=>{
    const h=await setup();
    expect(h.bootstrapTelegramId).toBeNull();
    expect((await h.app.inject('/api/board/tasks')).statusCode).toBe(401);
    expect((await h.app.inject('/mcp')).statusCode).toBe(401);
    await expect(h.access.identify('intruder@example.com')).rejects.toMatchObject({code:'forbidden'});
    h.identities.get('member@example.com')!.email_confirmed_at=null;
    await expect(h.access.identify('member@example.com')).rejects.toMatchObject({code:'unauthenticated'});
    expect((await h.db.query("SELECT email,role FROM workspace_members WHERE role='admin'")).rows).toEqual([{email:'ravi@antseed.com',role:'admin'}]);
  });
  it('creates only the authenticated owner’s task and rejects ownership injection',async()=>{
    const h=await setup(),input=h.task();
    const created=await h.app.inject({method:'POST',url:'/api/board/tasks',headers:h.headers(),payload:input});
    expect(created.statusCode).toBe(200);expect(created.json().owner_id).toBe(h.members.member!.id);
    const replay=await h.app.inject({method:'POST',url:'/api/board/tasks',headers:h.headers(),payload:input});
    expect(replay.json().id).toBe(created.json().id);
    const injected=await h.app.inject({method:'POST',url:'/api/board/tasks',headers:h.headers(),payload:{...h.task(),owner_id:h.members.other!.id}});
    expect(injected.statusCode).toBe(400);
    expect((await h.db.query('SELECT * FROM personal_tasks')).rowCount).toBe(1);
  });
  it('lets members read team tasks but rejects edits and deletes of someone else’s task, including by an admin',async()=>{
    const h=await setup();const task=(await h.app.inject({method:'POST',url:'/api/board/tasks',headers:h.headers(),payload:h.task()})).json();
    const edit={title:'Changed',description:'',lane:'Completed',dueDate:null,expectedVersion:0};
    for(const who of ['other','admin']){
      expect((await h.app.inject({method:'PATCH',url:'/api/board/tasks/'+task.id,headers:h.headers(who),payload:edit})).statusCode).toBe(404);
      expect((await h.app.inject({method:'DELETE',url:'/api/board/tasks/'+task.id,headers:h.headers(who),payload:{expectedVersion:0}})).statusCode).toBe(404);
    }
    expect((await h.app.inject({url:'/api/board/tasks?scope=team',headers:h.headers('other')})).json().items).toHaveLength(1);
    expect((await h.app.inject({url:'/api/board/tasks',headers:h.headers('other')})).json().items).toHaveLength(0);
    expect((await h.app.inject({method:'PATCH',url:'/api/board/tasks/'+task.id,headers:h.headers(),payload:edit})).statusCode).toBe(200);
    expect((await h.app.inject({method:'PATCH',url:'/api/board/tasks/'+task.id,headers:h.headers(),payload:edit})).statusCode).toBe(409);
    expect((await h.db.query('SELECT lane,version FROM personal_tasks')).rows).toEqual([{lane:'Completed',version:1}]);
  });
  it('keeps viewers read-only and denies legacy API and MCP write bypasses',async()=>{
    const h=await setup();
    expect((await h.app.inject({method:'POST',url:'/api/board/tasks',headers:h.headers('viewer'),payload:h.task()})).statusCode).toBe(403);
    for(const who of ['member','viewer'])for(const url of ['/api/outreach/proposals','/mcp'])
      expect((await h.app.inject({method:'POST',url,headers:h.headers(who),payload:{}})).statusCode).toBe(403);
    expect((await h.app.inject({url:'/api/workspace/members',headers:h.headers()})).statusCode).toBe(403);
  });
  it('records a human CRM move atomically without any Telegram notification or Vikunja publication',async()=>{
    const h=await setup();await h.outreach.reconcile();const r=(await h.outreach.listReviewRelationships({})).items[0]!;
    const input={expectedEvidenceRevision:r.evidenceRevision,targetStage:'qualification',idempotencyKey:'human-fixture',reason:'A human reviewed this relationship'};
    for(const who of ['member','viewer'])expect((await h.app.inject({method:'POST',url:`/api/board/approvals/relationships/${r.id}/place`,headers:h.headers(who),payload:input})).statusCode).toBe(403);
    const moved=await h.app.inject({method:'POST',url:`/api/board/approvals/relationships/${r.id}/place`,headers:h.headers('manager'),payload:input});
    expect(moved.statusCode).toBe(200);expect((await h.outreach.get(r.id)).relationship.acceptedStage).toBe('qualification');
    expect((await h.db.query('SELECT * FROM outreach_control_outbox')).rowCount).toBe(0);
    expect((await h.db.query('SELECT * FROM outreach_publications')).rowCount).toBe(0);
    expect((await h.db.query('SELECT * FROM outreach_remote_requests')).rowCount).toBe(0);
    expect((await h.db.query("SELECT * FROM workspace_audit WHERE action='crm.move'")).rowCount).toBe(1);
    expect((await h.outreach.listProposals({relationshipId:r.id})).items[0]).toMatchObject({origin:'manual',human_move:true,decision_source:'http'});
    expect((await h.app.inject({method:'POST',url:`/api/board/approvals/relationships/${r.id}/place`,headers:h.headers('manager'),payload:input})).statusCode).toBe(200);
    expect((await h.outreach.get(r.id)).relationship.stageVersion).toBe(1);
  });
  it('retains AI Telegram suggestions and invalidates them when a human makes a newer move',async()=>{
    const h=await setup();await h.outreach.reconcile();let r=(await h.outreach.listReviewRelationships({})).items[0]!;
    const ai=await h.outreach.propose({relationshipId:r.id,expectedEvidenceRevision:r.evidenceRevision,targetStage:'lead',idempotencyKey:'ai-fixture',reason:'Synthetic AI recommendation'},'openai');
    expect((await h.db.query('SELECT * FROM outreach_control_outbox')).rowCount).toBe(1);
    expect((await h.outreach.get(r.id)).relationship.acceptedStage).toBeNull();
    r=(await h.outreach.get(r.id)).relationship;
    await h.outreach.moveByHuman({relationshipId:r.id,expectedEvidenceRevision:r.evidenceRevision,targetStage:'qualification',idempotencyKey:'human-newer',reason:'Current human decision'},h.members.admin!);
    expect((await h.outreach.getProposal(String(ai.id))).state).toBe('stale');
    expect((await h.db.query('SELECT state FROM outreach_control_outbox')).rows).toEqual([{state:'cancelled'}]);
  });
  it('accepts AI approval replies only from a linked CRM manager and keeps stale human-move versions unchanged',async()=>{
    const h=await setup();await h.outreach.reconcile();let r=(await h.outreach.listReviewRelationships({})).items[0]!;
    await h.db.query("INSERT INTO chats(id,kind,title,inclusion,is_control) VALUES(-999,'supergroup','Synthetic approvals','excluded',true)");
    await h.db.query('UPDATE workspace_members SET telegram_user_id=123 WHERE id=$1',[h.members.manager!.id]);
    const p=await h.outreach.propose({relationshipId:r.id,expectedEvidenceRevision:r.evidenceRevision,targetStage:'qualification',idempotencyKey:'ai-telegram-fixture',reason:'Synthetic suggestion'},'openai');
    await h.db.query("UPDATE outreach_control_outbox SET chat_id=-999,message_id=600,state='sent' WHERE proposal_id=$1",[p.id]);
    const reply={chatId:'-999',messageId:601,senderId:'7',replyToMessageId:600,text:'approve',sentAt:new Date().toISOString()};
    await h.outreach.handleControlReply(reply);expect((await h.outreach.get(r.id)).relationship.acceptedStage).toBeNull();
    await h.outreach.handleControlReply({...reply,messageId:602,senderId:'123'});
    r=(await h.outreach.get(r.id)).relationship;expect(r.acceptedStage).toBe('qualification');
    expect((await h.outreach.listProposals({relationshipId:r.id})).items[0]).toMatchObject({origin:'openai',human_move:false,decision_source:'telegram'});
    expect((await h.db.query('SELECT * FROM outreach_publications')).rowCount).toBe(0);
    const stale=await h.app.inject({method:'POST',url:`/api/board/crm/${r.id}/move`,headers:h.headers('admin'),payload:{expectedEvidenceRevision:r.evidenceRevision-1,targetStage:'won',idempotencyKey:'stale-human',reason:'Outdated card'}});
    expect(stale.statusCode).toBe(409);expect((await h.outreach.get(r.id)).relationship.acceptedStage).toBe('qualification');
  });
  it('applies approved legacy Work locally once, without requiring a remote board',async()=>{
    const h=await setup();await h.db.query("INSERT INTO tickets(chat_id,kind) VALUES(-1001,'contact_prospect')");
    await h.db.query('INSERT INTO evidence(chat_id,message_id,message_version,excerpt,observed_at) VALUES(-1001,1,1,\'Synthetic evidence\',now())');
    const ticket=(await h.db.query('SELECT id FROM tickets')).rows[0]!,e=(await h.db.query('SELECT id FROM evidence')).rows[0]!;
    await h.db.query("UPDATE app_settings SET value='{"+'"enabled":false'+"}' WHERE key='workflow:crm-first'");
    const p=(await h.db.query(`INSERT INTO proposals(ticket_id,source_lane,source_stage_version,source_mapping_version,source_policy_version,target_lane,reason,origin,decision,apply_state,decided_at)
      VALUES($1,'To be started',0,0,0,'Work in progress','Approved fixture','manual','approved','queued',now()) RETURNING id`,[ticket.id])).rows[0]!;
    await h.db.query('INSERT INTO proposal_evidence(proposal_id,evidence_id) VALUES($1,$2)',[p.id,e.id]);
    const repo=new ProposalRepository(h.db,{subscribe:()=>()=>{},enqueueProposal:async()=>{}});
    const native=new NativeProposalWorkflow(repo);await native.applyNext();await native.applyNext();
    expect((await h.db.query('SELECT lane,stage_version,vikunja_task_id FROM tickets')).rows).toEqual([{lane:'Work in progress',stage_version:1,vikunja_task_id:null}]);
    expect((await repo.get(String(p.id))).applyState).toBe('applied');
  });
  it('allows only admins to grant roles, protects the last admin, and revokes access immediately',async()=>{
    const h=await setup(),viewer=h.members.viewer!;
    expect((await h.app.inject({method:'PATCH',url:'/api/workspace/members/'+h.members.manager!.id,headers:h.headers('admin'),payload:{role:'crm_manager',enabled:true,expectedVersion:0,telegramUserId:'99'}})).statusCode).toBe(409);
    expect((await h.app.inject({method:'PATCH',url:'/api/workspace/members/'+viewer.id,headers:h.headers(),payload:{role:'admin',enabled:true,expectedVersion:0}})).statusCode).toBe(403);
    expect((await h.app.inject({method:'PATCH',url:'/api/workspace/members/'+h.members.admin!.id,headers:h.headers('admin'),payload:{role:'member',enabled:true,expectedVersion:0}})).statusCode).toBe(409);
    expect((await h.app.inject({method:'PATCH',url:'/api/workspace/members/'+viewer.id,headers:h.headers('admin'),payload:{role:'viewer',enabled:false,expectedVersion:0}})).statusCode).toBe(200);
    expect((await h.app.inject({url:'/api/board/tasks',headers:h.headers('viewer')})).statusCode).toBe(403);
    const logout=await h.app.inject({method:'POST',url:'/auth/logout',headers:{cookie:'antseed_access=viewer@example.com',origin:'http://localhost:19490'},payload:{}});
    expect(logout.statusCode).toBe(200);expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0');
  });
  it('uses HttpOnly cookies and rejects cross-origin and unverified sessions',async()=>{
    const h=await setup();
    const login=await h.app.inject({method:'POST',url:'/auth/login',payload:{email:'member@example.com',password:'synthetic-password'}});
    expect(login.statusCode).toBe(200);expect(String(login.headers['set-cookie'])).toContain('HttpOnly');
    const cookie=login.cookies.map(c=>`${c.name}=${c.value}`).join('; ');
    expect((await h.app.inject({method:'POST',url:'/api/board/tasks',headers:{cookie,origin:'https://other.example'},payload:h.task()})).statusCode).toBe(403);
    expect((await h.app.inject({method:'POST',url:'/api/board/tasks',headers:{cookie,origin:'http://localhost:19490'},payload:h.task()})).statusCode).toBe(200);
    expect((await h.app.inject({url:'/api/board/tasks',headers:{authorization:'Bearer forged'}})).statusCode).toBe(401);
    h.failProvider();expect((await h.app.inject({url:'/api/board/tasks',headers:h.headers()})).statusCode).toBe(503);
  });
  it('allows email-confirmation navigation to sign-in while rejecting cross-site fetches and writes',async()=>{
    const h=await setup();
    const navigation={'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'};
    for(const method of ['GET','HEAD'] as const){
      expect((await h.app.inject({method,url:'/login',headers:navigation})).statusCode).toBe(200);
    }
    expect((await h.app.inject({url:'/login',headers:{...navigation,origin:'https://other.example'}})).statusCode).toBe(403);
    expect((await h.app.inject({url:'/login',headers:{...navigation,'sec-fetch-mode':'cors','sec-fetch-dest':'empty'}})).statusCode).toBe(403);
    expect((await h.app.inject({url:'/api/board/tasks',headers:{...navigation,...h.headers()}})).statusCode).toBe(403);
    expect((await h.app.inject({method:'POST',url:'/auth/login',headers:navigation,payload:{email:'member@example.com',password:'synthetic-password'}})).statusCode).toBe(403);
    expect((await h.app.inject({method:'POST',url:'/api/board/tasks',headers:{...navigation,...h.headers()},payload:h.task()})).statusCode).toBe(403);
  });
  it('keeps workspace audit immutable and enables database row-level protection',async()=>{
    const h=await setup();await h.app.inject({method:'POST',url:'/api/board/tasks',headers:h.headers(),payload:h.task()});
    await expect(h.db.query('DELETE FROM workspace_audit')).rejects.toThrow('immutable');
    const tables=(await h.db.query("SELECT relname,relrowsecurity FROM pg_class WHERE relname IN ('workspace_members','personal_tasks','workspace_audit')")).rows;
    expect(tables).toHaveLength(3);expect(tables.every(t=>t.relrowsecurity)).toBe(true);
  });
  it('validates Supabase public-key JWTs locally, checks issuer/audience/expiry, and ignores user-supplied role claims',async()=>{
    const h=await setup(),token=await h.sign(),before=h.userRequests(),headers={authorization:`Bearer ${token}`};
    expect((await h.app.inject({url:'/api/board/tasks',headers})).statusCode).toBe(200);
    expect((await h.app.inject({url:'/api/workspace/members',headers})).statusCode).toBe(403);
    expect(h.userRequests()).toBe(before); // Normal API requests use JWKS, not the Auth endpoint quota.
    for(const options of [{issuer:'https://another-project.example/auth/v1'},{audience:'anon'},{expires:'-1s'}]){
      const bad=await h.sign('member',options);
      expect((await h.app.inject({url:'/api/board/tasks',headers:{authorization:`Bearer ${bad}`}})).statusCode).toBe(401);
    }
    await h.db.query("UPDATE workspace_members SET role='viewer' WHERE id=$1",[h.members.member!.id]);
    expect((await h.app.inject({method:'POST',url:'/api/board/tasks',headers,payload:h.task()})).statusCode).toBe(403);
  });
});
