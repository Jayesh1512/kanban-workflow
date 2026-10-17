import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/platform/database.js';
import { TelegramStore } from '../src/telegram/store.js';
import { DurableControlBus, ControlSetupManager } from '../src/telegram/control.js';
import { SqlAnalysisQueue } from '../src/workflow/analysis.js';
import type { TelegramClient } from '@mtcute/node';
import type { TelegramMessageInput, TelegramPort } from '../src/shared/ports.js';
import { checkpoint, isolatedDatabase, sourceInput } from './qa-m31-support.js';

const project=process.env['QA_M2_PROJECT'];
export const qaTelegramConfig={apiId:1,apiHash:'QA-SYNTHETIC-NOT-A-REAL-HASH',sessionPath:':memory:',historyBatchSize:2,historyMaxBatches:2};
const self='990000099';
const source=(id='rel-028',revision=1):TelegramMessageInput=>{ const m=sourceInput(id,revision).messages[0]!; return {...m,sentAt:new Date(m.sentAt).toISOString(),editedAt:m.editedAt?new Date(m.editedAt).toISOString():null}; };
const ready={state:'ready' as const,code:null,detail:null,checkedAt:'2026-10-17T00:00:00Z'};
describe.skipIf(!project)('independent M2 actualPG durable events, synthetic Telegram transport',()=> {
  let f:Awaited<ReturnType<typeof isolatedDatabase>>,store:TelegramStore;
  beforeEach(async()=> { f=await isolatedDatabase(project!,true); store=new TelegramStore(f.db,qaTelegramConfig); });
  afterEach(async()=> { await f?.close(); });
  async function discover(m=source(),kind:'supergroup'|'user'='supergroup') { return store.upsertDialog({id:m.chatId,title:'QA synthetic company',kind,username:null,archived:true}); }
  it('applies actual additive migration/checksums, preserves exclusions/account binding across pool restart',async()=> {
    const c=await discover(); expect(c).toMatchObject({inclusion:'included',archived:true});
    await store.bindAccount(self); await expect(store.bindAccount('990000098')).rejects.toMatchObject({code:'conflict'});
    const input={chatId:c.id,expectedPolicyVersion:0,inclusion:'excluded' as const,idempotencyKey:'exclude'};
    expect(await store.setInclusion(input)).toMatchObject({inclusion:'excluded',policyVersion:1});
    expect(await store.setInclusion(input)).toMatchObject({inclusion:'excluded',policyVersion:1});
    await expect(store.setInclusion({...input,inclusion:'included'})).rejects.toMatchObject({code:'conflict'});
    await migrate(f.db); const db=await f.reopen(); store=new TelegramStore(db,qaTelegramConfig);
    expect(await discover()).toMatchObject({inclusion:'excluded',policyVersion:1});
    await store.ingest({type:'message',message:source()}); expect((await db.query('SELECT * FROM messages')).rows).toEqual([]);
    await expect(store.bindAccount('990000098')).rejects.toMatchObject({code:'conflict'});
    expect((await db.query('SELECT version FROM schema_migrations')).rows.map(r=>r.version)).toEqual(expect.arrayContaining(['001_initial.sql','202610170001_telegram_operations.sql']));
  });
  it('atomically snapshots message revisions and fences an in-flight old extraction after corpus028 correction',async()=> {
    const m=source(); await discover(m); await store.ingest({type:'message',message:m});
    await store.ingest({type:'message',message:{...m,sender:{...m.sender,observedAt:'2026-10-20T00:00:00Z'}}});
    expect((await f.db.query('SELECT version FROM messages')).rows).toEqual([{version:1}]);
    const queue=new SqlAnalysisQueue(f.db),old=(await queue.claim({workerId:'qa',leaseMs:60000}))!,saved=await checkpoint(queue,old);
    const peerStore=new TelegramStore(f.peer(),qaTelegramConfig);
    await peerStore.ingest({type:'edit',message:source('rel-028',2)});
    await expect(queue.saveExtraction(saved.value,old.claimToken)).rejects.toMatchObject({code:'conflict'});
    expect((await f.db.query('SELECT text,version FROM messages')).rows).toEqual([{text:source('rel-028',2).text,version:2}]);
    expect((await f.db.query('SELECT status FROM analysis_jobs WHERE id=$1',[old.id])).rows).toEqual([{status:'cancelled'}]);
    const current=(await f.db.query("SELECT s.message_version FROM analysis_job_messages s JOIN analysis_jobs j ON j.id=s.job_id WHERE j.status='pending'")).rows;
    expect(current).toEqual([{message_version:2}]);
    expect((await f.db.query('SELECT invalidated_at IS NOT NULL AS invalid FROM evidence')).rows).toEqual([{invalid:true}]);
    await peerStore.ingest({type:'message',message:m}); expect((await f.db.query('SELECT version FROM messages')).rows).toEqual([{version:2}]);
    expect((await f.db.query('SELECT * FROM proposals')).rows).toEqual([]); expect((await f.db.query('SELECT * FROM tickets')).rows).toEqual([]);
  });
  it('keeps mailbox/channel message101 scopes distinct; pre-discovery tombstones survive reopen and replay',async()=> {
    const base=source(), dm={...base,chatId:'42'},channel={...base,chatId:'-1000000000042'};
    await store.ingest({type:'delete',chatId:channel.chatId,messageIds:[101],observedAt:'2026-10-18T00:00:00Z'});
    expect((await f.db.query('SELECT * FROM chats')).rows).toEqual([]);
    const db=await f.reopen(); store=new TelegramStore(db,qaTelegramConfig);
    await discover(dm,'user'); await discover(channel);
    await Promise.all([store.ingest({type:'message',message:dm}),store.ingest({type:'message',message:channel})]);
    let rows=(await db.query('SELECT chat_id::text id,deleted_at IS NOT NULL deleted FROM messages ORDER BY chat_id')).rows;
    expect(rows).toEqual([{id:channel.chatId,deleted:true},{id:'42',deleted:false}]);
    await store.ingest({type:'delete',chatId:null,messageIds:[101],observedAt:'2026-10-19T00:00:00Z'});
    await store.ingest({type:'edit',message:{...channel,editedAt:'2026-10-20T00:00:00Z'}});
    rows=(await db.query('SELECT chat_id::text id,deleted_at IS NOT NULL deleted FROM messages ORDER BY chat_id')).rows;
    expect(rows.every(r=>r.deleted)).toBe(true);
    expect((await db.query('SELECT count(*)::int n FROM message_tombstones')).rows).toEqual([{n:2}]);
  });
  it('fences same-worker history adoption and policy exclusion without advancing either coverage cursor',async()=> {
    const m=source(); await discover(m);
    const first=(await store.claimHistory(m.chatId,'same-worker',60000))!;
    await f.db.query("UPDATE history_cursors SET lease_until=now()-interval '1 second'");
    const next=(await new TelegramStore(f.peer(),qaTelegramConfig).claimHistory(m.chatId,'same-worker',60000))!;
    expect(next.generation).toBeGreaterThan(first.generation);
    await expect(store.commitHistoryBatch(m.chatId,0,first.generation,{messages:[m],next:{messageId:101,date:m.sentAt},complete:false})).rejects.toMatchObject({code:'conflict'});
    await store.setInclusion({chatId:m.chatId,expectedPolicyVersion:0,inclusion:'excluded',idempotencyKey:'in-flight-exclusion'});
    await expect(store.commitHistoryBatch(m.chatId,0,next.generation,{messages:[m],next:{messageId:101,date:m.sentAt},complete:false})).rejects.toMatchObject({code:'conflict'});
    await expect(store.commitReplay({chatId:m.chatId,expectedPolicyVersion:0,expectedGeneration:0,messages:[m],highWaterMessageId:101})).rejects.toMatchObject({code:'conflict'});
    expect(await store.getCursor(m.chatId)).toMatchObject({nextMessageId:null,importedCount:0,status:'paused'});
    expect(await store.getLiveCheckpoint(m.chatId)).toMatchObject({highWaterMessageId:null,replayRequired:true});
    expect((await f.db.query('SELECT * FROM messages')).rows).toEqual([]);
  });
  it('persists unknown control creation before transport, forbids duplicate creation and reconciles one receipt after restart',async()=> {
    let creates=0,receiptVisible=false; const remoteId=-1000000005555;
    const client={ async createSupergroup() { creates++; expect((await f.db.query('SELECT state FROM control_setup_operations')).rows).toEqual([{state:'remote_unknown'}]); throw Error('Synthetic accepted remotely then connection lost'); },
      async *iterDialogs() { if(receiptVisible)yield {peer:{id:remoteId,type:'chat',chatType:'supergroup',title:'QA control',username:null},isArchived:false}; },
      async getFullChat() { return {bio:`QA ${(await f.db.query('SELECT marker FROM control_setup_operations ORDER BY created_at LIMIT 1')).rows[0]!.marker}`}; }
    } as unknown as TelegramClient;
    let setup=new ControlSetupManager(f.db,store,()=>client); const request={operationKey:'qa-unknown-create',createPrivateSupergroup:true as const,title:'QA synthetic approvals'};
    expect(await setup.configure(request)).toMatchObject({state:'remote_unknown'});
    // Unknown -> reconcile reads only, even if a second key is supplied.
    await expect(setup.configure({...request,operationKey:'other-key'})).rejects.toMatchObject({code:'conflict'}); expect(creates).toBe(1);
    const db=await f.reopen(); store=new TelegramStore(db,qaTelegramConfig); setup=new ControlSetupManager(db,store,()=>client);
    // Automatic readback was added after M2: keep the receipt genuinely hidden
    // until restart to retain this test's unknown-outcome recovery window.
    receiptVisible=true;
    expect(await setup.configure(request)).toMatchObject({state:'configured',chat:{id:String(remoteId)}}); expect(creates).toBe(1);
    expect((await store.list({})).items[0]).toMatchObject({id:String(remoteId),inclusion:'excluded',isControl:true});
    await expect(store.setInclusion({chatId:String(remoteId),expectedPolicyVersion:1,inclusion:'included',idempotencyKey:'control-must-stay-excluded'})).rejects.toMatchObject({code:'conflict'});
    await store.ingest({type:'message',message:{...source(),chatId:String(remoteId),senderId:self,text:'Approve synthetic proposal'}});
    expect((await db.query('SELECT text,sender_id::text FROM control_inbox')).rows).toEqual([{text:'Approve synthetic proposal',sender_id:self}]);
    expect((await db.query('SELECT * FROM messages')).rows).toEqual([]); expect((await db.query('SELECT * FROM analysis_jobs')).rows).toEqual([]);
  });
  it('retains operational inbox without subscriber, retries after handler error, and fences an expired handler acknowledgement',async()=> {
    const m=source(); await discover(m); await f.db.query("UPDATE chats SET is_control=true,inclusion='excluded'");
    await store.ingest({type:'message',message:{...m,senderId:self,text:'No decision yet'}});
    const telegram={status:async()=>ready} as unknown as TelegramPort;
    const bus=new DurableControlBus(f.db,telegram); await bus.tick(); expect((await f.db.query('SELECT state,attempts FROM control_inbox')).rows).toEqual([{state:'pending',attempts:0}]);
    const off=bus.subscribe(async()=> { throw Error('Synthetic interrupted consumer'); }); await bus.tick(); off();
    expect((await f.db.query('SELECT state,last_error FROM control_inbox')).rows[0]).toMatchObject({state:'pending',last_error:'Control handler unavailable; decision retained for retry'});
    await f.db.query("UPDATE control_inbox SET lease_until=now()-interval '1 second'");
    const offExpired=bus.subscribe(async()=> { await f.db.query("UPDATE control_inbox SET lease_until=now()-interval '1 second'"); }); await bus.tick(); offExpired();
    expect((await f.db.query('SELECT state FROM control_inbox')).rows).toEqual([{state:'running'}]);
    let deliveries=0; const db=await f.reopen(), reopened=new DurableControlBus(db,telegram); reopened.subscribe(async()=> {deliveries++;}); await reopened.tick();
    expect(deliveries).toBe(1); expect((await db.query('SELECT state,attempts FROM control_inbox')).rows).toEqual([{state:'done',attempts:3}]);
  });
  it('deduplicates an equivalent RFC3339 instant at the IngestionStore boundary',async()=> {
    const m=source(); await discover(m); await store.ingest({type:'message',message:m});
    await store.ingest({type:'message',message:{...m,sentAt:m.sentAt.replace('.000Z','Z')}});
    expect((await f.db.query('SELECT version FROM messages')).rows).toEqual([{version:1}]);
  });

  it('reuses one durable MTProto randomId and reconciles accepted-send/lost-response after pool restart',async()=> {
    const business=source(), controlId='-1000000007777';await discover(business);
    await store.upsertDialog({id:controlId,kind:'supergroup',title:'QA operational group',username:null,archived:false});
    await f.db.query("UPDATE chats SET is_control=true,inclusion='excluded' WHERE id=$1",[controlId]);
    const c=(await f.db.query("INSERT INTO companies(canonical_name) VALUES('QA transport only') RETURNING id")).rows[0]!;
    await f.db.query("UPDATE chats SET company_id=$1,mapping_status='confirmed' WHERE id=$2",[c.id,business.chatId]);
    const ticket=(await f.db.query('INSERT INTO tickets(chat_id,company_id) VALUES($1,$2) RETURNING id',[business.chatId,c.id])).rows[0]!;
    const proposal=(await f.db.query("INSERT INTO proposals(ticket_id,source_lane,source_stage_version,source_mapping_version,source_policy_version,target_lane,reason,origin) VALUES($1,'To be started',0,0,0,'Completed','Authored transport fixture, not model approval','manual') RETURNING id",[ticket.id])).rows[0]!;
    const sent:Array<{chatId:string;text:string;randomId:string}>=[];
    const telegram={status:async()=>ready,authorizedSelf:async()=>self,
      async sendControlMessage(input:{chatId:string;text:string;randomId:string}){sent.push(input);throw Error('QA transport accepted then response lost');},
      async getHistory(){return{messages:[{...source(),chatId:controlId,id:401,senderId:self,text:sent[0]!.text}],next:null,complete:true};}
    } as unknown as TelegramPort;
    let bus=new DurableControlBus(f.db,telegram);
    await f.db.transaction(tx=>bus.enqueueProposal(tx,{proposalId:String(proposal.id),chatId:controlId,text:'Synthetic approval request'}));
    await f.db.transaction(tx=>bus.enqueueProposal(tx,{proposalId:String(proposal.id),chatId:controlId,text:'Duplicate enqueue must not replace payload'}));
    const before=(await f.db.query('SELECT random_id::text random_id,text FROM control_outbox')).rows[0]!;
    expect(BigInt(before.random_id)).not.toBe(0n);expect(BigInt(before.random_id)>=-(2n**63n)&&BigInt(before.random_id)<2n**63n).toBe(true);
    await bus.tick();expect(sent).toHaveLength(1);expect(sent[0]!.randomId).toBe(before.random_id);
    const db=await f.reopen();await db.query("UPDATE control_outbox SET lease_until=now()-interval '1 second'");bus=new DurableControlBus(db,telegram);await bus.tick();
    expect(sent).toHaveLength(1);expect((await db.query('SELECT state,message_id,random_id::text random_id FROM control_outbox')).rows).toEqual([{state:'sent',message_id:401,random_id:before.random_id}]);
    expect((await db.query('SELECT lane,stage_version FROM tickets')).rows).toEqual([{lane:'To be started',stage_version:0}]);
  });

});
