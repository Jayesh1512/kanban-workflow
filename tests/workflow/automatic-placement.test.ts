import { DurableControlBus } from '../../src/telegram/control.js';
import type { PgDatabase } from '../../src/platform/database.js';
import type { TelegramPort } from '../../src/shared/ports.js';
import { randomUUID } from 'node:crypto';
import { afterEach,expect,it } from 'vitest';
import { workflowHarness } from './harness.js';
import { decisionFixture } from '../intelligence/fixtures.js';
const cleanup:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
const cutoff='2026-10-04T18:30:00.000Z';
async function freshEvidence(h:Awaited<ReturnType<typeof setup>>){
 const id=randomUUID();await h.db.query("INSERT INTO messages(chat_id,id,sent_at,text) VALUES(-1001,999,now()+interval '1 minute','Fresh post-placement update')");
 await h.db.query("INSERT INTO evidence(id,chat_id,message_id,message_version,excerpt,observed_at) VALUES($1,-1001,999,1,'Fresh post-placement update',now())",[id]);return id;
}

async function setup(){const h=await workflowHarness();cleanup.push(()=>h.db.close());await h.configureControl();await h.db.query("INSERT INTO app_settings(key,value) VALUES('telegram:automatic-since',$1)",[JSON.stringify({enabled:true,revision:'policy-v1',cutoff,initialPlacement:true})]);await h.db.query("INSERT INTO telegram_conversation_starts(chat_id,state,first_message_at,checked_cutoff) VALUES(-1001,'qualifies','2026-10-05',$1)",[cutoff]);return h;}
async function recommend(h:Awaited<ReturnType<typeof setup>>,target:'Integrations'|'Completed'='Integrations',origin='openai'){
 const decision=decisionFixture(h.evidenceId);decision.diagnostics.rubricVersion=origin==='openai'?'openai.decisions.antseed.v3':'jev.v1';decision.lane={outcome:'propose',targetLane:target,evidenceIds:[h.evidenceId],reason:'Authored sourced recommendation; not a real model',nextAction:null};
 const jobId=randomUUID();await h.db.query("INSERT INTO analysis_jobs(id,chat_id,policy_version,mapping_version,dedupe_key,status,decision) SELECT $1::uuid,id,policy_version,mapping_version,($1::uuid)::text,'completed',$2 FROM chats WHERE id=-1001",[jobId,JSON.stringify(decision)]);
 return {decision,jobId};
}
// The real SQL proposal hook is used below; authored native decisions do not
// establish semantic model quality or real Telegram/Vikunja transport evidence.
it('places the initial sourced recommendation through the journal without a group approval, then requires approval for later movement',async()=>{
 const h=await setup();const {decision,jobId}=await recommend(h);await h.db.transaction(tx=>h.proposals.recordAnalysisDecisionTx(tx,{jobId,ticketId:h.ticket.id,expectedStageVersion:0,decision}));
 expect((await h.db.query('SELECT * FROM control_outbox')).rows).toHaveLength(0);expect(await h.proposals.placeInitialAutomatically()).toBe(1);expect(await h.proposals.placeInitialAutomatically()).toBe(0);
 expect((await h.db.query('SELECT source,note FROM proposal_decisions')).rows[0]).toMatchObject({source:'automation',note:expect.stringContaining('initial placement')});await h.service.applyNext();expect(await h.records.getTicket(h.ticket.id)).toMatchObject({lane:'Integrations',stageVersion:1});expect(h.moves()).toBe(1);
 const laterEvidence=await freshEvidence(h);const later=decisionFixture(laterEvidence);later.diagnostics.rubricVersion='openai.decisions.antseed.v3';later.lane={outcome:'propose',targetLane:'Completed',reason:'Later recommendation',nextAction:null,evidenceIds:[laterEvidence]};
 await h.db.transaction(tx=>h.proposals.recordAnalysisDecisionTx(tx,{jobId:randomUUID(),ticketId:h.ticket.id,expectedStageVersion:1,decision:later}));expect(await h.proposals.placeInitialAutomatically()).toBe(0);expect((await h.db.query('SELECT * FROM control_outbox')).rows).toHaveLength(1);expect(h.moves()).toBe(1);
});
it.each(['no_change','uncertain'] as const)('records initial %s without a move; a later recommendation goes to approvals',async outcome=>{
 const h=await setup(),decision=decisionFixture(h.evidenceId);decision.lane={outcome,reason:'Initial assessment',evidenceIds:[h.evidenceId]};await h.db.transaction(tx=>h.proposals.recordAnalysisDecisionTx(tx,{jobId:randomUUID(),ticketId:h.ticket.id,expectedStageVersion:0,decision}));
 expect((await h.db.query('SELECT initial_result FROM telegram_conversation_starts')).rows[0]!['initial_result']).toBe(outcome);
 const laterEvidence=await freshEvidence(h);const later=decisionFixture(laterEvidence);later.diagnostics.rubricVersion='openai.decisions.antseed.v3';later.lane={outcome:'propose',targetLane:'Integrations',reason:'Later change',nextAction:null,evidenceIds:[laterEvidence]};await h.db.transaction(tx=>h.proposals.recordAnalysisDecisionTx(tx,{jobId:randomUUID(),ticketId:h.ticket.id,expectedStageVersion:0,decision:later}));expect(await h.proposals.placeInitialAutomatically()).toBe(0);expect((await h.db.query('SELECT * FROM control_outbox')).rows).toHaveLength(1);
});
it('never auto-approves an older conversation or a manual recommendation',async()=>{
 const h=await setup();await h.db.query("UPDATE telegram_conversation_starts SET state='older',first_message_at='2020-01-01'");const p=await h.propose();expect(await h.proposals.placeInitialAutomatically()).toBe(0);expect((await h.proposals.get(p.id)).decision).toBe('pending');
});

it('does not send leftover initial-history recommendations to the approval group after the first assessment',async()=>{
 const h=await setup();const first=decisionFixture(h.evidenceId);first.lane={outcome:'uncertain',reason:'Initial history',evidenceIds:[h.evidenceId]};await h.db.transaction(tx=>h.proposals.recordAnalysisDecisionTx(tx,{jobId:randomUUID(),ticketId:h.ticket.id,expectedStageVersion:0,decision:first}));
 const later=decisionFixture(h.evidenceId);later.diagnostics.rubricVersion='openai.decisions.antseed.v3';later.lane={outcome:'propose',targetLane:'Integrations',reason:'Another old history window',nextAction:null,evidenceIds:[h.evidenceId]};
 await h.db.transaction(tx=>h.proposals.recordAnalysisDecisionTx(tx,{jobId:randomUUID(),ticketId:h.ticket.id,expectedStageVersion:0,decision:later}));expect((await h.db.query('SELECT * FROM control_outbox')).rows).toHaveLength(0);expect((await h.db.query('SELECT * FROM proposals')).rows).toHaveLength(0);
});

it('defers initial AI notifications before date classification and releases older-conversation review normally',async()=>{
 const h=await setup();await h.db.query("UPDATE telegram_conversation_starts SET state='pending',checked_cutoff=NULL");const {decision,jobId}=await recommend(h);await h.db.transaction(tx=>h.proposals.recordAnalysisDecisionTx(tx,{jobId,ticketId:h.ticket.id,expectedStageVersion:0,decision}));
 await h.proposals.flushPendingControl();expect((await h.db.query('SELECT * FROM control_outbox')).rows).toHaveLength(0);
 await h.db.query("UPDATE telegram_conversation_starts SET state='older',first_message_at='2020-01-01',checked_cutoff=$1",[cutoff]);await h.proposals.flushPendingControl();expect((await h.db.query('SELECT * FROM control_outbox')).rows).toHaveLength(1);expect(await h.proposals.placeInitialAutomatically()).toBe(0);
});
it('holds an already queued initial AI notification until its scope is known, without changing later-review policy',async()=>{
 const h=await setup();const p=await h.propose();await h.db.query("UPDATE proposals SET origin='openai' WHERE id=$1",[p.id]);await h.db.query("UPDATE telegram_conversation_starts SET state='pending',checked_cutoff=NULL");let sends=0;
 const bus=new DurableControlBus(h.db as PgDatabase,{status:async()=>({state:'ready'}),sendControlMessage:async()=>{sends++;return {messageId:50};}} as unknown as TelegramPort);await bus.tick();expect(sends).toBe(0);
 await h.db.query("UPDATE telegram_conversation_starts SET state='older',checked_cutoff=$1,first_message_at='2020-01-01'",[cutoff]);await bus.tick();expect(sends).toBe(1);
});

const groupApprovalFrom='2026-10-23T13:48:42.677Z';
async function futureGroup(h:Awaited<ReturnType<typeof setup>>,at=groupApprovalFrom,kind='supergroup'){
 await h.db.query("UPDATE app_settings SET value=value||$1::jsonb WHERE key='telegram:automatic-since'",[JSON.stringify({groupApprovalFrom})]);
 await h.db.query('UPDATE chats SET kind=$1 WHERE id=-1001',[kind]);
 await h.db.query('UPDATE telegram_conversation_starts SET first_message_at=$1 WHERE chat_id=-1001',[at]);
}
it('requires a real correlated control approval for the first recommendation in a future group and every later change',async()=>{
 const h=await setup();await futureGroup(h);const {decision,jobId}=await recommend(h);
 await h.db.transaction(tx=>h.proposals.recordAnalysisDecisionTx(tx,{jobId,ticketId:h.ticket.id,expectedStageVersion:0,decision}));
 const p=(await h.proposals.list({})).items[0]!;expect(await h.proposals.placeInitialAutomatically()).toBe(0);
 expect(p).toMatchObject({decision:'pending',applyState:'not_requested',lastError:null});
 expect((await h.db.query('SELECT source FROM proposal_decisions')).rows).toHaveLength(0);
 expect(await h.service.applyNext()).toBeNull();expect(h.moves()).toBe(0);
 let sends=0;const bus=new DurableControlBus(h.db as PgDatabase,{status:async()=>({state:'ready'}),sendControlMessage:async()=>{sends++;return {messageId:50};}} as unknown as TelegramPort);
 await bus.tick();await bus.tick();expect(sends).toBe(1);
 expect((await h.db.query('SELECT state,message_id FROM control_outbox')).rows[0]).toEqual({state:'sent',message_id:50});
 await h.proposals.handleControlReply({chatId:'-2001',messageId:51,senderId:'99',replyToMessageId:50,text:'approve',sentAt:h.clock.now().toISOString()});
 await h.service.applyNext();expect(await h.records.getTicket(h.ticket.id)).toMatchObject({lane:'Integrations',stageVersion:1});expect(h.moves()).toBe(1);
 expect((await h.db.query('SELECT source FROM proposal_decisions')).rows).toEqual([{source:'telegram'}]);
 const laterEvidence=await freshEvidence(h);decision.lane={outcome:'propose',targetLane:'Completed',reason:'Later update',nextAction:null,evidenceIds:[laterEvidence]};
 await h.db.transaction(tx=>h.proposals.recordAnalysisDecisionTx(tx,{jobId:randomUUID(),ticketId:h.ticket.id,expectedStageVersion:1,decision}));
 expect(await h.proposals.placeInitialAutomatically()).toBe(0);expect(await h.service.applyNext()).toBeNull();expect(h.moves()).toBe(1);
 expect((await h.db.query('SELECT * FROM control_outbox')).rows).toHaveLength(2);
});
it.each(['group','supergroup'])('preserves automatic initial import for an older %s even when discovered after the new policy',async kind=>{
 const h=await setup();await futureGroup(h,'2026-10-23T13:48:42.676Z',kind);await h.db.query('UPDATE chats SET discovered_at=now()');
 const {decision,jobId}=await recommend(h);await h.db.transaction(tx=>h.proposals.recordAnalysisDecisionTx(tx,{jobId,ticketId:h.ticket.id,expectedStageVersion:0,decision}));
 expect((await h.db.query('SELECT * FROM control_outbox')).rows).toHaveLength(0);expect(await h.proposals.placeInitialAutomatically()).toBe(1);
});
it('leaves private-chat automatic initial placement unchanged',async()=>{
 const h=await setup();await futureGroup(h,groupApprovalFrom,'user');const {decision,jobId}=await recommend(h);
 await h.db.transaction(tx=>h.proposals.recordAnalysisDecisionTx(tx,{jobId,ticketId:h.ticket.id,expectedStageVersion:0,decision}));expect(await h.proposals.placeInitialAutomatically()).toBe(1);
});
it('holds pre-classification delivery then releases the future group recommendation for approval without marking it automatically placed',async()=>{
 const h=await setup();await futureGroup(h);await h.db.query("UPDATE telegram_conversation_starts SET state='pending',checked_cutoff=NULL");
 const {decision,jobId}=await recommend(h);await h.db.transaction(tx=>h.proposals.recordAnalysisDecisionTx(tx,{jobId,ticketId:h.ticket.id,expectedStageVersion:0,decision}));
 expect((await h.db.query('SELECT * FROM control_outbox')).rows).toHaveLength(0);
 await h.db.query("UPDATE telegram_conversation_starts SET state='qualifies',checked_cutoff=$1",[cutoff]);await h.proposals.flushPendingControl();
 expect((await h.db.query('SELECT * FROM control_outbox')).rows).toHaveLength(1);expect(await h.proposals.placeInitialAutomatically()).toBe(0);
 expect((await h.db.query('SELECT initial_placement_at FROM telegram_conversation_starts')).rows[0]).toEqual({initial_placement_at:null});
});
it('does not suppress a future group first proposal after an initial no-change assessment',async()=>{
 const h=await setup();await futureGroup(h);const {decision,jobId}=await recommend(h);const first=decisionFixture(h.evidenceId);first.lane={outcome:'no_change',reason:'No change',evidenceIds:[h.evidenceId]};
 await h.db.transaction(tx=>h.proposals.recordAnalysisDecisionTx(tx,{jobId:randomUUID(),ticketId:h.ticket.id,expectedStageVersion:0,decision:first}));
 await h.db.transaction(tx=>h.proposals.recordAnalysisDecisionTx(tx,{jobId,ticketId:h.ticket.id,expectedStageVersion:0,decision}));expect((await h.db.query('SELECT * FROM control_outbox')).rows).toHaveLength(1);expect(await h.proposals.placeInitialAutomatically()).toBe(0);
});
it('fails closed on a malformed new-group approval boundary rather than auto-approving',async()=>{
 const h=await setup();await futureGroup(h);await h.db.query("UPDATE app_settings SET value=jsonb_set(value,'{groupApprovalFrom}','\"invalid\"') WHERE key='telegram:automatic-since'");
 const {decision,jobId}=await recommend(h);await h.db.transaction(tx=>h.proposals.recordAnalysisDecisionTx(tx,{jobId,ticketId:h.ticket.id,expectedStageVersion:0,decision}));expect(await h.proposals.placeInitialAutomatically()).toBe(0);expect((await h.db.query('SELECT * FROM control_outbox')).rows).toHaveLength(1);
});
