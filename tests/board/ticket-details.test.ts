import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { AccessControl } from '../../src/access/service.js';
import { buildApp } from '../../src/app.js';
import { registerBoard } from '../../src/board/routes.js';
import { OutreachWorkflow } from '../../src/outreach/service.js';
import { fixtureDatabase } from '../workflow/database.js';

const close:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const fn of close.splice(0).reverse())await fn();});
async function setup(){
 const names=['202610250001_outreach_core.sql','202610260001_outreach_workflow.sql','202610260002_stable_outreach_sources.sql','202610270004_operator_intake_approvals.sql','202610280001_crm_first.sql','202610290001_native_workspace.sql','202610300001_work_task_ownership.sql','202610310001_ticket_headline.sql'];
 const db=await fixtureDatabase(names.map(name=>new URL('../../db/migrations/'+name,import.meta.url)));close.push(()=>db.close());
 const identities=new Map(['admin','manager','viewer','member'].map(role=>[role,{id:randomUUID(),email:role+'@example.com',email_confirmed_at:'2026-10-29T00:00:00Z'}]));
 const access=new AccessControl(db,{supabaseUrl:'https://synthetic.example',publishableKey:'synthetic',adminEmail:null,appUrl:'http://localhost:19491',crmApproval:'direct'},async(_url,init)=>{
  const token=(init?.headers as Record<string,string>)?.Authorization?.replace('Bearer ','');
  return new Response(JSON.stringify(identities.get(token??'')),{status:200});
 });
 for(const role of identities.keys())await db.query('INSERT INTO workspace_members(email,role) VALUES($1,$2)',[role+'@example.com',role==='manager'?'crm_manager':role]);
 const app=await buildApp();close.push(()=>app.close());await access.register(app);app.decorate('workspaceAccess',access);
 const outreach=new OutreachWorkflow(db,{now:()=>new Date()},{provider:'openai',endpoint:'https://api.openai.com/v1/decisions',model:'gpt-6-luna',apiKey:null,timeoutMs:1000,maxAttempts:1},{nativeBoard:true});
 registerBoard(app,db,outreach,async()=>{});
 const company=(await db.query("INSERT INTO companies(canonical_name) VALUES('Test Company') RETURNING id")).rows[0]!;
 await db.query("UPDATE chats SET mapping_status='confirmed',company_id=$1 WHERE id=-1001",[company.id]);
 const ticket=(await db.query("INSERT INTO tickets(chat_id,company_id,summary,next_action,blockers) VALUES(-1001,$1,'Stored summary','Do the next thing',ARRAY['Waiting for access']) RETURNING id",[company.id])).rows[0]!;
 const headers=(role='manager')=>({authorization:'Bearer '+role});
 const move=(targetLane='Blocked',version=0)=>({targetLane,expectedStageVersion:version,reason:'Human update from the board',idempotencyKey:randomUUID()});
 return {app,db,outreach,access,id:String(ticket.id),headers,move};
}
describe('ticket detail panel API',()=>{
 it('gives viewers the current Work record, source context and paginated history without mutation authority',async()=>{
  const h=await setup();
  const detail=await h.app.inject({url:`/api/board/work/${h.id}/detail`,headers:h.headers('viewer')});
  expect(detail.statusCode).toBe(200);expect(detail.json()).toMatchObject({ticket:{id:h.id,summary:'Stored summary',nextAction:'Do the next thing',blockers:['Waiting for access']},company:{canonicalName:'Test Company'}});
  expect(detail.json().messages).toHaveLength(1);expect(detail.json().metadata.created_at).toBeTruthy();
  const listed=(await h.app.inject({url:'/api/board/work',headers:h.headers('viewer')})).json();
  expect(listed.items).toHaveLength(1);expect(listed.items[0].id).toBe(h.id);
  for(const who of ['viewer','member'])expect((await h.app.inject({method:'POST',url:`/api/board/work/${h.id}/move`,headers:h.headers(who),payload:h.move()})).statusCode).toBe(403);
  expect((await h.app.inject(`/api/board/work/${h.id}/detail`)).statusCode).toBe(401);
 });
 it('moves immediately once, records the actor and reason, stales pending suggestions, and sends no Telegram message',async()=>{
  const h=await setup();
  await h.db.query(`INSERT INTO proposals(ticket_id,source_lane,source_stage_version,source_mapping_version,source_policy_version,target_lane,reason,origin)
   VALUES($1,'To be started',0,0,0,'Completed','AI suggestion','openai')`,[h.id]);
  const pendingUrl=`/api/board/work/${h.id}/detail`;
  expect((await h.app.inject({url:pendingUrl,headers:h.headers('viewer')})).json().proposals).toEqual([]);
  expect((await h.app.inject({url:pendingUrl,headers:h.headers('member')})).json().proposals).toEqual([]);
  expect((await h.app.inject({url:pendingUrl,headers:h.headers()})).json().proposals).toHaveLength(1);
  const payload=h.move();
  for(let attempt=0;attempt<2;attempt++)expect((await h.app.inject({method:'POST',url:`/api/board/work/${h.id}/move`,headers:h.headers(),payload})).json()).toMatchObject({id:h.id,lane:'Blocked',stageVersion:1});
  expect((await h.db.query('SELECT lane,previous_active_lane,stage_version FROM tickets WHERE id=$1',[h.id])).rows[0]).toEqual({lane:'Blocked',previous_active_lane:'To be started',stage_version:1});
  expect((await h.db.query('SELECT apply_state,last_error FROM proposals WHERE ticket_id=$1',[h.id])).rows).toEqual([{apply_state:'stale',last_error:'human_move'}]);
  const audit=(await h.db.query('SELECT action,after_value FROM workspace_audit WHERE resource_id=$1',[h.id])).rows;
  expect(audit).toHaveLength(1);expect(audit[0]).toMatchObject({action:'work.move',after_value:{lane:'Blocked',reason:payload.reason}});
  expect((await h.db.query('SELECT count(*)::int AS n FROM control_outbox')).rows[0]!.n).toBe(0);
  expect((await h.app.inject({method:'POST',url:`/api/board/work/${h.id}/move`,headers:h.headers(),payload:{...h.move('Completed'),idempotencyKey:payload.idempotencyKey}})).statusCode).toBe(409);
  expect((await h.app.inject({method:'POST',url:`/api/board/work/${h.id}/move`,headers:h.headers(),payload:h.move('Completed')})).statusCode).toBe(409);
 });
 it('rejects changes when source access, membership or mapping changes',async()=>{
  const h=await setup();
  await h.db.query("UPDATE chats SET inclusion='excluded' WHERE id=-1001");
  expect((await h.app.inject({url:'/api/board/work',headers:h.headers('viewer')})).json().items).toEqual([]);
  expect((await h.app.inject({url:`/api/board/work/${h.id}/detail`,headers:h.headers('viewer')})).statusCode).toBe(404);
  expect((await h.app.inject({method:'POST',url:`/api/board/work/${h.id}/move`,headers:h.headers(),payload:h.move()})).statusCode).toBe(409);
  await h.db.query("UPDATE chats SET inclusion='included',mapping_status='ambiguous',company_id=NULL WHERE id=-1001");
  expect((await h.app.inject({method:'POST',url:`/api/board/work/${h.id}/move`,headers:h.headers(),payload:h.move()})).statusCode).toBe(409);
  await h.db.query("UPDATE workspace_members SET enabled=false WHERE email='manager@example.com'");
  expect((await h.app.inject({method:'POST',url:`/api/board/work/${h.id}/move`,headers:h.headers(),payload:h.move()})).statusCode).toBe(403);
 });
 it('paginates stored messages without duplicates and omits deleted messages',async()=>{
  const h=await setup();
  await h.db.query(`INSERT INTO messages(chat_id,id,sent_at,text,sender_snapshot,peer_snapshot,forward_metadata)
   SELECT chat_id,g,now(),'Message '||g,sender_snapshot,peer_snapshot,forward_metadata FROM messages CROSS JOIN generate_series(2,56) g WHERE chat_id=-1001 AND id=1`);
  await h.db.query('UPDATE messages SET deleted_at=now() WHERE chat_id=-1001 AND id=54');
  const detail=(await h.app.inject({url:`/api/board/work/${h.id}/detail`,headers:h.headers('viewer')})).json();
  expect(detail.messages).toHaveLength(50);expect(detail.messages.map((m:{id:number})=>m.id)).not.toContain(54);
  const older=(await h.app.inject({url:`/api/board/work/${h.id}/messages?cursor=${detail.messagesCursor}`,headers:h.headers('viewer')})).json();
  expect(older.items).toHaveLength(5);expect(new Set([...detail.messages,...older.items].map((m:{id:number})=>m.id)).size).toBe(55);expect(older.nextCursor).toBeNull();
 });
 it('opens personal tasks for everyone and preserves owner-only editing',async()=>{
  const h=await setup();const actor=await h.access.identify('member');
  const task=(await h.db.query("INSERT INTO personal_tasks(owner_id,title,description,lane,creation_key) VALUES($1,'Personal title','Full description','To be started',$2) RETURNING id",[actor.id,randomUUID()])).rows[0]!;
  expect((await h.app.inject({url:`/api/board/tasks/${task.id}`,headers:h.headers('viewer')})).json()).toMatchObject({task:{title:'Personal title',description:'Full description',owner_id:actor.id},history:[]});
  expect((await h.app.inject({method:'PATCH',url:`/api/board/tasks/${task.id}`,headers:h.headers('admin'),payload:{title:'Changed',lane:'Completed',expectedVersion:0}})).statusCode).toBe(404);
 });
 it('keeps unplaced CRM private, exposes accepted source details, and rejects Work from a suspended CRM source',async()=>{
  const h=await setup();await h.outreach.reconcile();
  const r=(await h.outreach.listReviewRelationships({limit:100})).items.find(r=>r.displayName==='Test Company')!;
  expect(r).toBeTruthy();
  expect((await h.app.inject({url:`/api/board/crm/${r.id}/detail`,headers:h.headers('viewer')})).statusCode).toBe(404);
  const placement=await h.outreach.moveByHuman({relationshipId:r.id,expectedEvidenceRevision:r.evidenceRevision,targetStage:'lead',reason:'Accepted fixture',idempotencyKey:randomUUID()},await h.access.identify('manager'),'unplaced');
  const detail=await h.app.inject({url:`/api/board/crm/${r.id}/detail`,headers:h.headers('viewer')});
  expect(detail.statusCode).toBe(200);expect(detail.json()).toMatchObject({relationship:{acceptedStage:'lead'},company:{canonicalName:'Test Company'}});
  expect(detail.json().activeSources).toHaveLength(1);expect(detail.json().history).toHaveLength(1);
  const accepted=detail.json().relationship;
  await h.outreach.propose({relationshipId:r.id,expectedEvidenceRevision:accepted.evidenceRevision,targetStage:'qualification',reason:'Private pending review reason',idempotencyKey:randomUUID()},'openai');
  for(const who of ['viewer','member']){
   const visible=(await h.app.inject({url:`/api/board/crm/${r.id}/detail`,headers:h.headers(who)})).json();
   expect(visible.proposals.some((p:{reason:string})=>p.reason==='Private pending review reason')).toBe(false);
  }
  const manager=(await h.app.inject({url:`/api/board/crm/${r.id}/detail`,headers:h.headers()})).json();
  expect(manager.proposals.some((p:{reason:string})=>p.reason==='Private pending review reason')).toBe(true);
  await h.db.query('UPDATE tickets SET crm_relationship_id=$2,creation_proposal_id=$3 WHERE id=$1',[h.id,r.id,placement.id]);
  await h.db.query("UPDATE outreach_relationship_sources SET enrollment_state='suspended' WHERE relationship_id=$1",[r.id]);
  expect((await h.app.inject({url:`/api/board/work/${h.id}/detail`,headers:h.headers('viewer')})).statusCode).toBe(409);
  expect((await h.app.inject({method:'POST',url:`/api/board/work/${h.id}/move`,headers:h.headers(),payload:h.move()})).statusCode).toBe(409);
 });
});
