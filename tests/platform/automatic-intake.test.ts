import { DurableControlBus } from '../../src/telegram/control.js';
import type { TelegramPort } from '../../src/shared/ports.js';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { tl } from '@mtcute/node';
import { telegramFixture,fixtureMessage } from './telegram-fixture.js';
import { AutomaticIntake, type ConversationStart } from '../../src/telegram/automatic-intake.js';
const cutoff='2026-10-04T18:30:00.000Z';
let f:Awaited<ReturnType<typeof telegramFixture>>,worker:AutomaticIntake,result:ConversationStart,reads:number;
beforeEach(async()=>{
 f=await telegramFixture({approvalFirst:true});reads=0;result={at:'2026-10-05T01:00:00.000Z',messageId:1,uncertain:false,reason:'first_available_message'};
 await f.db.query("INSERT INTO app_settings(key,value) VALUES('telegram:automatic-since',$1)",[JSON.stringify({enabled:true,revision:'fixture-policy',cutoff,initialPlacement:true})]);
 worker=new AutomaticIntake(f.db,f.store,{async conversationStart(){reads++;return result;}});
});
afterEach(async()=>{await f.db.close();});
async function discover(id='7',latest='2026-10-23T00:00:00Z'){await f.store.upsertDialog({id,kind:'user',title:'Synthetic conversation',username:null,archived:false,latestMessageAt:latest});}
async function again(){await f.db.query("DELETE FROM app_settings WHERE key='telegram:automatic:last-scan'");await worker.tick();}
it('includes only first conversations at/after the inclusive IST cutoff, without intake request or message-body capture',async()=>{
 await discover();await worker.tick();expect(reads).toBe(1);expect((await f.db.query('SELECT inclusion FROM chats WHERE id=7')).rows[0]!['inclusion']).toBe('included');
 expect((await f.db.query('SELECT lane,stage_version FROM tickets')).rows[0]).toEqual({lane:'To be started',stage_version:0});expect((await f.db.query('SELECT state FROM telegram_conversation_starts')).rows[0]!['state']).toBe('qualifies');
 expect((await f.db.query('SELECT * FROM chat_intake_requests')).rowCount).toBe(0);expect((await f.db.query('SELECT * FROM messages')).rowCount).toBe(0);expect((await f.store.getCursor('7')).status).toBe('pending');
 await again();expect(reads).toBe(1);expect((await f.db.query('SELECT * FROM tickets')).rowCount).toBe(1);
});
it.each([['2026-10-04T18:29:59.999Z','older'],[cutoff,'qualifies']])('uses exact midnight IST boundary %s -> %s',async(at,state)=>{
 await discover();result.at=at;await worker.tick();expect((await f.db.query('SELECT state FROM telegram_conversation_starts')).rows[0]!['state']).toBe(state);
});
it('does not confuse recent activity in an older conversation with a new conversation',async()=>{
 await discover();result.at='2021-01-01T00:00:00Z';await worker.tick();expect((await f.db.query('SELECT inclusion FROM chats')).rows[0]!['inclusion']).toBe('undecided');expect((await f.db.query('SELECT * FROM tickets')).rowCount).toBe(0);
});
it('uses an already known old message or old last activity as exclusion proof without an extra RPC',async()=>{
 await discover();await f.db.query("INSERT INTO messages(chat_id,id,sent_at,text) VALUES(7,1,'2020-01-01','Previously stored older message')");await worker.tick();expect(reads).toBe(0);
 await discover('8','2026-10-01T00:00:00Z');await again();expect(reads).toBe(0);expect((await f.db.query("SELECT state FROM telegram_conversation_starts WHERE chat_id=8")).rows[0]!['state']).toBe('older');
});
it.each(['hidden_earlier_history','migrated_conversation_requires_original_history','empty_history'])('keeps uncertain %s out',async reason=>{
 await discover();result={at:reason==='empty_history'?null:result.at,messageId:1,uncertain:true,reason};await worker.tick();expect((await f.db.query('SELECT state FROM telegram_conversation_starts')).rows[0]!['state']).toBe('unknown');expect((await f.db.query('SELECT * FROM tickets')).rowCount).toBe(0);
});
it('never imports a control group, excluded chat or the saved-messages self dialog',async()=>{
 await discover();await discover('-1001');await discover('123');await f.db.query("UPDATE chats SET inclusion='excluded' WHERE id=7");await f.db.query("UPDATE chats SET inclusion='excluded',is_control=true WHERE id=-1001");await worker.tick();expect(reads).toBe(0);
});
it('fences policy changes and exclusion during the remote boundary probe',async()=>{
 await discover();worker=new AutomaticIntake(f.db,f.store,{async conversationStart(){await f.db.query("UPDATE chats SET inclusion='excluded',policy_version=policy_version+1 WHERE id=7");return result;}});await worker.tick();expect((await f.db.query('SELECT * FROM tickets')).rowCount).toBe(0);expect((await f.db.query('SELECT inclusion FROM chats')).rows[0]!['inclusion']).toBe('excluded');
});
it('does not send an approval request while automatic-since classification is pending',async()=>{
 await discover();await f.store.ingest({type:'message',message:{...fixtureMessage(1,'7'),senderId:'7',sentAt:new Date().toISOString()}});expect((await f.db.query('SELECT * FROM chat_intake_requests')).rowCount).toBe(0);expect((await f.db.query('SELECT * FROM messages')).rowCount).toBe(0);
});
it('retains a native flood wait for global backoff rather than marking a new chat eligible',async()=>{
 await discover();worker=new AutomaticIntake(f.db,f.store,{async conversationStart(){throw tl.RpcError.fromTl({errorCode:420,errorMessage:'FLOOD_WAIT_60'});}});
 await expect(worker.tick()).rejects.toHaveProperty('seconds',60);expect((await f.db.query('SELECT state,reason FROM telegram_conversation_starts')).rows[0]).toEqual({state:'error',reason:'history_probe_retry'});expect((await f.db.query('SELECT * FROM tickets')).rowCount).toBe(0);
});

it('holds existing intake requests during automatic classification and cancels them on qualification without a send',async()=>{
 await discover();await f.store.setInclusion({chatId:'7',inclusion:'included',expectedPolicyVersion:0,idempotencyKey:'old-queued-request'});
 await f.store.upsertDialog({id:'-1001',kind:'supergroup',title:'Control',username:null,archived:false});await f.db.query("UPDATE chats SET inclusion='excluded',is_control=true WHERE id=-1001");
 let sends=0;const bus=new DurableControlBus(f.db,{status:async()=>({state:'ready'}),sendControlMessage:async()=>{sends++;return {messageId:50};}} as unknown as TelegramPort,f.store);
 await bus.tick();expect(sends).toBe(0);await worker.tick();await bus.tick();expect(sends).toBe(0);expect((await f.db.query('SELECT decision FROM chat_intake_requests')).rows[0]!['decision']).toBe('cancelled');
});
it('preserves an already placed card and treats its later recommendations as ordinary approval work',async()=>{
 await discover();await f.db.query("UPDATE chats SET inclusion='included' WHERE id=7");await f.db.query("INSERT INTO tickets(chat_id,company_id,kind,lane,stage_version) VALUES(7,NULL,'contact_prospect','Integrations',2)");
 await worker.tick();expect((await f.db.query('SELECT lane,stage_version FROM tickets')).rows[0]).toEqual({lane:'Integrations',stage_version:2});expect((await f.db.query('SELECT initial_result FROM telegram_conversation_starts')).rows[0]).toEqual({initial_result:'no_change'});
});
