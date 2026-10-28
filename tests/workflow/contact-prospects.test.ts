import { ChatIntake } from '../../src/telegram/intake.js';
import type { TelegramPort } from '../../src/shared/ports.js';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Extraction } from '../../src/shared/domain.js';
import type { ControlBus, Database } from '../../src/shared/ports.js';
import { SqlAnalysisQueue, inputHash } from '../../src/workflow/analysis.js';
import { RecordsRepository } from '../../src/workflow/records.js';
import { ProposalRepository } from '../../src/workflow/proposals.js';
import { TelegramStore } from '../../src/telegram/store.js';
import type { PgDatabase } from '../../src/platform/database.js';
import { OPENAI_DECISIONS_VERSION, parseOpenAIDecisions } from '../../src/intelligence/openai-decisions.js';
import { currentTicketMapping } from '../../src/shared/ticket-mapping.js';
import { outbound, recommendation } from '../intelligence/outbound-fixtures.js';
import { provenance } from '../intelligence/fixtures.js';
import { fixtureDatabase, seedJob } from './database.js';
let db: Database, queue: SqlAnalysisQueue, records: RecordsRepository, proposals: ProposalRepository;
const clock = { now:()=>new Date('2026-10-17T03:00:00Z') };
const decisionProvenance = {...provenance(),model:'gpt-6-luna',schemaVersion:OPENAI_DECISIONS_VERSION};
beforeEach(async()=>{
  db=await fixtureDatabase();
  await db.query("UPDATE analysis_jobs SET status='cancelled'");
  const m=outbound().messages[0]!;m.sender.names=['Jayesh'];m.peer.names=['Harsh'];m.peer.usernames=['harsh'];m.text='Hi Harsh, Jayesh here from AntSeed. Would you like to try our API services?';
  await db.query("INSERT INTO chats(id,kind,title,inclusion) VALUES(7,'user','Harsh','included')");
  await db.query("INSERT INTO chat_intake_requests(chat_id,policy_version,decision,control_chat_id,message_id,delivery_state,decided_message_id,decided_at) VALUES(7,0,'approved',-1001,9101,'sent',9102,now())");
  await db.query('INSERT INTO messages(chat_id,id,sender_id,sent_at,text,sender_snapshot,peer_snapshot,forward_metadata) VALUES(7,1,99,$1,$2,$3,$4,$5)',[m.sentAt,m.text,m.sender,m.peer,m.forward]);
  proposals=new ProposalRepository(db,{} as ControlBus,clock);records=new RecordsRepository(db,clock);
  queue=new SqlAnalysisQueue(db,clock,'Asia/Kolkata',{onDecision:(tx,input)=>proposals.recordAnalysisDecisionTx(tx,input)});
});
afterEach(async()=>{await db?.close();});
async function prepare(forwarded = false) {
  if(forwarded) await db.query("UPDATE messages SET forward_metadata=jsonb_set(forward_metadata,'{isForwarded}','true') WHERE chat_id=7");
  const id=randomUUID();await seedJob(db,id,'7');const job=(await queue.claim({workerId:'prospect',leaseMs:60000}))!;expect(job.id).toBe(id);
  const input=await queue.loadInput(id),evidenceIds=input.evidence.map(e=>e.id);
  const extraction: Extraction={companyCandidates:[],companies:[],contacts:forwarded?[]:[{telegramUserIds:['7'],names:['Harsh'],usernames:['harsh'],phones:[],emails:[],affiliation:'unknown',roles:[],evidenceIds}],facts:[],dates:[],summary:'AntSeed API enquiry to Harsh; company unknown and awaiting reply.',substantive:true,evidenceIds};
  await queue.saveExtraction({jobId:id,inputHash:inputHash(input),extraction,provenance:provenance()},job.claimToken);
  const raw=recommendation();
  for(const a of raw.answers){if(a.type==='choice'&&(a.name==='company_match'||a.name==='relevance')){a.choice=a.name==='company_match'?'none':'uncertain';for(const p of a.probabilities)p.probability=p.value===a.choice?1:0;}if(a.name==='outbound_enquiry'&&a.type==='predicate')a.probability=0.99;}
  return {job,input,extraction,raw};
}
async function createProspect(){const h=await prepare();const decision=parseOpenAIDecisions(h.raw,{...h.input,extraction:h.extraction});expect(decision.outreach).toMatchObject({outcome:'enquiry'});await queue.complete(h.job.id,decision,decisionProvenance,h.job.claimToken);return {...h,ticket:(await records.listTickets({})).items[0]!};}
it('creates a source-backed contact card with null company, preserved contacts and no invented directory entry or movement',async()=>{
  const h=await createProspect();expect(h.ticket).toMatchObject({kind:'contact_prospect',companyId:null,lane:'To be started',stageVersion:0});
  expect((await records.listCompanies({})).items).toHaveLength(0);
  const context=await records.getContext({ticketId:h.ticket.id,limit:100});expect(context.company).toBeNull();expect(context.contacts).toMatchObject([{telegramUserIds:['7'],names:['Harsh'],affiliation:'unknown',roles:[]}]);expect(context.outreach?.waitingForReply).toBe(true);expect(currentTicketMapping(context.chat,context.ticket)).toBe(true);
  expect((await db.query('SELECT mapping_status,company_id FROM chats WHERE id=7')).rows[0]).toEqual({mapping_status:'unresolved',company_id:null});
  expect((await db.query('SELECT id FROM proposals')).rows).toHaveLength(0);expect((await db.query('SELECT id FROM mutations')).rows).toHaveLength(0);
});
it.each(['uncertain','nonbusiness','forwarded','foreign_evidence','no_native_support'])('does not manufacture a prospect from %s evidence',async mode=>{
  const h=await prepare(mode==='forwarded');if(mode==='uncertain'){const a=h.raw.answers.find(a=>a.name==='outbound_enquiry')!;if(a.type==='predicate')a.probability=0.7;}
  if(mode==='nonbusiness'){const a=h.raw.answers.find(a=>a.name==='relevance')!;if(a.type==='choice'){a.choice='non_company';for(const p of a.probabilities)p.probability=p.value==='non_company'?1:0;}}
  const decision=parseOpenAIDecisions(h.raw,{...h.input,extraction:h.extraction});
  if(mode==='forwarded')decision.outreach={outcome:'enquiry',probability:0.99,evidenceIds:h.extraction.evidenceIds};
  if(mode==='foreign_evidence')decision.outreach!.evidenceIds=[randomUUID()];
  if(mode==='no_native_support')delete decision.diagnostics.answers.outbound_enquiry;
  await queue.complete(h.job.id,decision,decisionProvenance,h.job.claimToken);expect((await records.listTickets({})).items).toHaveLength(0);expect((await records.listCompanies({})).items).toHaveLength(0);
});
it('upgrades the same prospect after sourced company identification and creates only a pending stage proposal',async()=>{
  const h=await createProspect();await db.query('UPDATE tickets SET vikunja_task_id=88 WHERE id=$1',[h.ticket.id]);
  const original=h.input.messages[0]!,text='I am Harsh from Cedar Labs. Yes, please send pricing for our engineering review.';
  await db.query('INSERT INTO messages(chat_id,id,sender_id,sent_at,text,sender_snapshot,peer_snapshot,forward_metadata) VALUES(7,2,7,$1,$2,$3,$4,$5)',['2026-10-17T02:00:00Z',text,original.peer,original.peer,original.forward]);
  const id=randomUUID();await seedJob(db,id,'7',2);const job=(await queue.claim({workerId:'prospect',leaseMs:60000}))!,input=await queue.loadInput(job.id),newEvidence=input.evidence.find(e=>e.messageId===2)!.id;
  const extraction: Extraction={...h.extraction,companies:[{canonicalName:'Cedar Labs',aliases:[],domains:[],buyerIds:[],providerIds:[],evidenceIds:[newEvidence]}],companyCandidates:[{companyId:null,canonicalName:'Cedar Labs',confidence:1,evidenceIds:[newEvidence]}],contacts:[{...h.extraction.contacts[0]!,affiliation:'external',evidenceIds:[newEvidence]}],evidenceIds:input.evidence.map(e=>e.id)};
  await queue.saveExtraction({jobId:job.id,inputHash:inputHash(input),extraction,provenance:provenance()},job.claimToken);
  const decision=parseOpenAIDecisions(recommendation(),{...input,extraction});expect(decision.lane.outcome).toBe('propose');await queue.complete(job.id,decision,decisionProvenance,job.claimToken);
  const tickets=(await records.listTickets({})).items;expect(tickets).toHaveLength(1);expect(tickets[0]).toMatchObject({id:h.ticket.id,kind:'company',companyId:expect.any(String),vikunjaTaskId:'88',lane:'To be started',stageVersion:0});
  expect((await records.getContext({ticketId:h.ticket.id,limit:100})).company?.canonicalName).toBe('Cedar Labs');expect((await proposals.list({})).items).toMatchObject([{decision:'pending',applyState:'not_requested',origin:'openai',targetLane:'Work in progress'}]);expect((await db.query('SELECT id FROM mutations')).rows).toHaveLength(0);
});
it('preserves exclusion/reinclusion and operator mapping corrections for a prospect',async()=>{
  // SQL-only store methods here; this fixture does not establish session-loss behavior.
  const h=await createProspect(),store=new TelegramStore(db as PgDatabase,{apiId:null,apiHash:null,sessionPath:':memory:',historyBatchSize:10,historyMaxBatches:1});
  await store.setInclusion({chatId:'7',inclusion:'excluded',expectedPolicyVersion:0,idempotencyKey:'exclude'});expect((await records.getTicket(h.ticket.id)).trackingState).toBe('suspended');
  await store.setInclusion({chatId:'7',inclusion:'included',expectedPolicyVersion:1,idempotencyKey:'include'});
  expect((await records.getTicket(h.ticket.id)).trackingState).toBe('suspended');
  await db.query("INSERT INTO chats(id,kind,title,inclusion,is_control) VALUES(-1009,'supergroup','Synthetic approvals','excluded',true)");
  await db.query("UPDATE chat_intake_requests SET control_chat_id=-1009,message_id=50,delivery_state='sent' WHERE chat_id=7 AND decision='pending'");
  await new ChatIntake(db as PgDatabase,store,{} as TelegramPort).handle({chatId:'-1009',messageId:51,senderId:'99',replyToMessageId:50,text:'approve',sentAt:new Date().toISOString()});
  expect((await records.getTicket(h.ticket.id)).trackingState).toBe('active');
  const company=await records.createCompany({idempotencyKey:'manual-company',canonicalName:'Manually confirmed company',aliases:[],domains:[],buyerIds:[],providerIds:[],workstream:null,summary:'',evidenceIds:[]});
  await store.correctMapping({chatId:'7',companyId:company.id,status:'confirmed',expectedMappingVersion:0,reason:'Operator supplies known company',source:'http',evidenceIds:h.input.evidence.map(e=>e.id),idempotencyKey:'map'});
  expect(await records.getTicket(h.ticket.id)).toMatchObject({kind:'company',companyId:company.id,trackingState:'active'});expect((await records.listTickets({})).items).toHaveLength(1);
});
it('reanalyses a previously completed unmapped enquiry only through explicit scoped idempotent replay',async()=>{
  const h=await prepare(),decision=parseOpenAIDecisions(h.raw,{...h.input,extraction:h.extraction});delete decision.outreach;await queue.complete(h.job.id,decision,decisionProvenance,h.job.claimToken);
  expect((await records.listTickets({})).items).toHaveLength(0);await expect(queue.replayUnavailable({idempotencyKey:'unscoped',includeCompletedUnmapped:true})).rejects.toThrow('one explicit chat');
  const request={idempotencyKey:'scoped',chatId:'7',includeCompletedUnmapped:true};expect(await queue.replayUnavailable(request)).toEqual({queued:1});expect(await queue.replayUnavailable(request)).toEqual({queued:1});expect((await db.query('SELECT status,decision,extraction FROM analysis_jobs WHERE id=$1',[h.job.id])).rows[0]).toMatchObject({status:'pending',decision:null,extraction:h.extraction});
});
