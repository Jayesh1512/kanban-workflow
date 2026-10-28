import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { telegramFixture, fixtureMessage } from './telegram-fixture.js';
import { ChatIntake } from '../../src/telegram/intake.js';
import { DurableControlBus } from '../../src/telegram/control.js';
import type { TelegramPort } from '../../src/shared/ports.js';

describe('approval-first incoming chat intake, real SQL and controlled Telegram transport', () => {
 let f: Awaited<ReturnType<typeof telegramFixture>>;
 let sent: { chatId: string; text: string; randomId: string; id: number }[];
 let lost = false;
 let intake: ChatIntake, bus: DurableControlBus;
 beforeEach(async () => {
  f = await telegramFixture({ approvalFirst: true }); sent=[];
  await f.store.upsertDialog({ id:'-1001',kind:'supergroup',title:'Approvals',username:null,archived:false });
  await f.db.query("UPDATE chats SET is_control=true,inclusion='excluded' WHERE id=-1001");
  const port = { status:async()=>({state:'ready'}),authorizedSelf:async()=>'123',
   sendControlMessage:async(input:{chatId:string;text:string;randomId:string})=>{const found=sent.find(s=>s.randomId===input.randomId);const row=found??{...input,id:50+sent.length};if(!found)sent.push(row);if(lost){lost=false;throw Error('accepted but response lost');}return {messageId:row.id};},
   getHistory:async()=>({messages:sent.map(s=>fixtureMessage(s.id,s.chatId,s.text)),next:null,complete:true}) } as unknown as TelegramPort;
  intake=new ChatIntake(f.db,f.store,port); bus=new DurableControlBus(f.db,port,f.store);
 });
 afterEach(async()=>{await f.db.close();});
 async function discover(id='7'){return f.store.upsertDialog({id,kind:'user',title:'New contact',username:null,archived:false});}
 async function incoming(id='7', messageId=1){await f.store.ingest({type:'message',message:{...fixtureMessage(messageId,id),senderId:id,sentAt:new Date(Date.now()+1000).toISOString()}});}
 async function reply(text:string,messageId=100,replyTo=sent[0]!.id){await f.store.ingest({type:'message',message:{...fixtureMessage(messageId,'-1001',text),replyToId:replyTo,sentAt:new Date().toISOString()}});await bus.tick();}
 it('metadata alone sends nothing; incoming message queues metadata only, with no import, jobs or card before approve',async()=>{
  expect((await discover()).inclusion).toBe('undecided');await bus.tick();expect(sent).toHaveLength(0);
  await incoming();await bus.tick();expect(sent).toHaveLength(1);expect(sent[0]!.text).toContain('Add this chat');expect(sent[0]!.text).not.toContain('Synthetic operational fixture');
  for(const table of ['messages','analysis_jobs','tickets'])expect((await f.db.query(`SELECT 1 FROM ${table}`)).rowCount).toBe(0);
  expect((await f.store.getCursor('7')).status).toBe('paused');expect(await f.store.claimHistory('7','worker',1000)).toBeNull();
  await expect(f.store.requestImport({chatId:'7',idempotencyKey:'bypass-import',maxBatches:1,batchSize:2})).rejects.toMatchObject({code:'excluded_chat'});
  await reply('approve');expect((await f.db.query('SELECT inclusion,policy_version FROM chats WHERE id=7')).rows[0]).toMatchObject({inclusion:'included',policy_version:1});
  expect((await f.db.query('SELECT lane,stage_version,kind,company_id FROM tickets WHERE chat_id=7')).rows[0]).toEqual({lane:'To be started',stage_version:0,kind:'contact_prospect',company_id:null});
  expect((await f.store.getCursor('7')).status).toBe('pending');await incoming('7',2);expect((await f.db.query('SELECT 1 FROM messages')).rowCount).toBe(1);expect((await f.db.query('SELECT 1 FROM analysis_jobs')).rowCount).toBe(1);
  await reply('approve',101);await reply('reject',102);expect((await f.db.query('SELECT 1 FROM tickets')).rowCount).toBe(1);expect((await f.db.query('SELECT inclusion FROM chats WHERE id=7')).rows[0]!['inclusion']).toBe('included');
  expect((await f.db.query('SELECT 1 FROM mutations')).rowCount).toBe(0);
 });
 it('reject and no reply keep chats out; rediscovery and new messages cannot reopen rejected requests',async()=>{
  await discover();await incoming();await bus.tick();await reply('reject');await discover();await incoming('7',2);await bus.tick();expect(sent).toHaveLength(1);
  expect((await f.db.query('SELECT inclusion FROM chats WHERE id=7')).rows[0]!['inclusion']).toBe('excluded');expect((await f.db.query('SELECT 1 FROM messages')).rowCount).toBe(0);
  await discover('8');await incoming('8');expect((await f.db.query('SELECT inclusion FROM chats WHERE id=8')).rows[0]!['inclusion']).toBe('undecided');
 });
 it('UI/MCP inclusion requests cannot admit; historical directory requires manual selection, not live message/rediscovery',async()=>{
  await discover();await f.db.query("UPDATE chats SET intake_origin='historical' WHERE id=7");await incoming();await discover();await bus.tick();expect(sent).toHaveLength(0);
  const input={chatId:'7',expectedPolicyVersion:0,inclusion:'included' as const,idempotencyKey:'manual-select'};
  expect((await f.store.setInclusion(input)).inclusion).toBe('undecided');await f.store.setInclusion(input);expect((await f.db.query('SELECT 1 FROM chat_intake_requests')).rowCount).toBe(1);await bus.tick();expect(sent).toHaveLength(1);
  expect((await f.db.query('SELECT 1 FROM tickets')).rowCount).toBe(0);await reply('approve');expect((await f.db.query('SELECT 1 FROM tickets')).rowCount).toBe(1);
 });
 it('our first outbound enquiry requests intake; old catch-up messages, edits, control and excluded chats do not add another request',async()=>{
  await discover();await f.store.ingest({type:'message',message:{...fixtureMessage(1,'7'),sentAt:new Date().toISOString()}});
  expect((await f.db.query("SELECT decision FROM chat_intake_requests WHERE chat_id=7")).rows).toEqual([{decision:'pending'}]);
  await f.store.ingest({type:'message',message:{...fixtureMessage(2,'7'),senderId:'7'}});
  await f.store.ingest({type:'edit',message:{...fixtureMessage(3,'7'),senderId:'7',sentAt:new Date(Date.now()+1000).toISOString()}});
  await bus.tick();expect(sent).toHaveLength(1);expect((await f.db.query('SELECT 1 FROM chat_intake_requests')).rowCount).toBe(1);
 });
 it('keeps an early approval pending while accepted-send linkage is recovered; one physical message and one card',async()=>{
  await discover();await incoming();lost=true;await bus.tick();expect(sent).toHaveLength(1);
  await f.db.query("UPDATE chat_intake_requests SET lease_until=now()-interval '1 second'");await reply('approve');
  expect((await f.db.query('SELECT state FROM control_inbox')).rows[0]!['state']).toBe('pending');expect((await f.db.query('SELECT delivery_state FROM chat_intake_requests')).rows[0]!['delivery_state']).toBe('sent');
  await f.db.query("UPDATE control_inbox SET lease_until=now()-interval '1 second'");await bus.tick();expect((await f.db.query('SELECT state FROM control_inbox')).rows[0]!['state']).toBe('done');expect((await f.db.query('SELECT 1 FROM tickets')).rowCount).toBe(1);expect(sent).toHaveLength(1);
 });
 it('paces notifications and stops at five awaiting replies across restart',async()=>{
  for(let id=7;id<14;id++){await discover(String(id));await incoming(String(id));}
  await bus.tick();await bus.tick();expect(sent).toHaveLength(1);
  for(let i=0;i<7;i++){await f.db.query("DELETE FROM app_settings WHERE key='telegram:intake:last-send'");await intake.sendOne();}
  expect(sent).toHaveLength(5);await reply('reject');await f.db.query("DELETE FROM app_settings WHERE key='telegram:intake:last-send'");await bus.tick();expect(sent).toHaveLength(6);
 });
 it('ignores unrelated and stale replies; explicit exclude fences in-flight admission',async()=>{
  await discover();await incoming();await bus.tick();await reply('approve',100,999);expect((await f.db.query('SELECT 1 FROM tickets')).rowCount).toBe(0);
  await f.store.setInclusion({chatId:'7',expectedPolicyVersion:0,inclusion:'excluded',idempotencyKey:'exclude-first'});await reply('approve',101);expect((await f.db.query('SELECT inclusion FROM chats WHERE id=7')).rows[0]!['inclusion']).toBe('excluded');expect((await f.db.query('SELECT 1 FROM tickets')).rowCount).toBe(0);
 });
 it('rebinds pending requests to a replacement control group with a new random ID; old-group replies cannot admit',async()=>{
  await discover();await incoming();await bus.tick();const first=sent[0]!;
  await f.store.upsertDialog({id:'-1002',kind:'supergroup',title:'Replacement approvals',username:null,archived:false});
  await f.db.query("UPDATE chats SET is_control=false WHERE id=-1001");await f.db.query("UPDATE chats SET is_control=true,inclusion='excluded' WHERE id=-1002");
  await f.db.query("DELETE FROM app_settings WHERE key='telegram:intake:last-send'");await bus.tick();expect(sent).toHaveLength(2);expect(sent[1]!.randomId).not.toBe(first.randomId);expect(sent[1]!.chatId).toBe('-1002');
  expect(await intake.handle({chatId:'-1001',messageId:100,senderId:'123',replyToMessageId:first.id,text:'approve',sentAt:new Date().toISOString()})).toBe(false);
  await f.store.ingest({type:'message',message:{...fixtureMessage(101,'-1002','approve'),replyToId:sent[1]!.id}});await bus.tick();expect((await f.db.query('SELECT 1 FROM tickets')).rowCount).toBe(1);
 });
 it('does not process intake or send when the production migration readiness callback is blocked',async()=>{
  await discover();await incoming();
  // The ready transport is checked first, then the gate, before any effects.
  const port={status:async()=>({state:'ready'})} as unknown as TelegramPort;
  const guarded=new DurableControlBus(f.db,port,f.store,async()=>{throw Error('checksum blocked');});
  await expect(guarded.tick()).rejects.toThrow('checksum blocked');expect((await f.db.query('SELECT attempts FROM chat_intake_requests')).rows[0]!['attempts']).toBe(0);expect(sent).toHaveLength(0);
 });

});
