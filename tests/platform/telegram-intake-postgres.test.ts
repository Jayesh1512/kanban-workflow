import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PgDatabase, migrate } from '../../src/platform/database.js';
import { TelegramStore } from '../../src/telegram/store.js';
import { DurableControlBus } from '../../src/telegram/control.js';
import type { TelegramPort } from '../../src/shared/ports.js';
import { fixtureMessage } from './telegram-fixture.js';

const url = process.env['INTAKE_TEST_DATABASE_URL'];
describe.skipIf(!url)('real PostgreSQL intake concurrency and persisted restart (Telegram transport is synthetic)',()=>{
 let admin:PgDatabase,db:PgDatabase,other:PgDatabase,schema:string,store:TelegramStore,bus:DurableControlBus,bus2:DurableControlBus,sends:number;
 beforeEach(async()=>{
  admin=new PgDatabase(url!);schema=`intake_${randomUUID().replaceAll('-','')}`;await admin.query(`CREATE SCHEMA ${schema}`);
  const scoped=new URL(url!);scoped.searchParams.set('options',`-c search_path=${schema},public`);db=new PgDatabase(scoped.toString());other=new PgDatabase(scoped.toString());await migrate(db);
  store=new TelegramStore(db,{apiId:null,apiHash:null,sessionPath:':memory:',historyBatchSize:20,historyMaxBatches:2});await store.bindAccount('123');
  await store.upsertDialog({id:'-1001',kind:'supergroup',title:'Synthetic control',username:null,archived:false});await db.query("UPDATE chats SET is_control=true,inclusion='excluded' WHERE id=-1001");sends=0;
  const port={status:async()=>({state:'ready'}),authorizedSelf:async()=>'123',sendControlMessage:async()=>({messageId:50+sends++})} as unknown as TelegramPort;
  bus=new DurableControlBus(db,port,store);bus2=new DurableControlBus(other,port,new TelegramStore(other,{apiId:null,apiHash:null,sessionPath:':memory:',historyBatchSize:20,historyMaxBatches:2}));
 });
 afterEach(async()=>{await db.close();await other.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();});
 async function incoming(){await store.upsertDialog({id:'7',kind:'user',title:'New prospect',username:null,archived:false});await Promise.all(Array.from({length:8},(_,i)=>store.ingest({type:'message',message:{...fixtureMessage(i+1,'7'),senderId:'7',sentAt:new Date(Date.now()+1000).toISOString()}})));}
 it('dedupes concurrent first messages and concurrent control workers; persisted reply admits one card only',async()=>{
  await incoming();expect((await db.query('SELECT 1 FROM chat_intake_requests')).rowCount).toBe(1);expect((await db.query('SELECT 1 FROM messages')).rowCount).toBe(0);
  await Promise.all([bus.tick(),bus2.tick()]);expect(sends).toBe(1);
  await store.ingest({type:'message',message:{...fixtureMessage(100,'-1001','approve'),replyToId:50}});
  await Promise.all([bus.tick(),bus2.tick()]);expect((await db.query('SELECT inclusion,policy_version FROM chats WHERE id=7')).rows[0]).toEqual({inclusion:'included',policy_version:1});expect((await db.query('SELECT lane,stage_version FROM tickets')).rows).toEqual([{lane:'To be started',stage_version:0}]);
  await store.ingest({type:'message',message:{...fixtureMessage(101,'-1001','reject'),replyToId:50}});await bus2.tick();expect((await db.query('SELECT decision FROM chat_intake_requests')).rows[0]).toEqual({decision:'approved'});expect(sends).toBe(1);
 });
 it('row-lock serializes exclusion against admission; whichever commits first cannot reopen a rejected source',async()=>{
  await incoming();await bus.tick();await store.ingest({type:'message',message:{...fixtureMessage(100,'-1001','approve'),replyToId:50}});
  let release!:()=>void,held!:()=>void;const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{held=r;});
  const excluded=other.transaction(async tx=>{const c=await store.lockedChat(tx,'7');held();await gate;await store.changeInclusion(tx,c,'excluded');});await ready;const decision=bus.tick();await new Promise(r=>setTimeout(r,50));release();await Promise.all([excluded,decision]);
  expect((await db.query('SELECT inclusion FROM chats WHERE id=7')).rows[0]).toEqual({inclusion:'excluded'});expect((await db.query('SELECT 1 FROM tickets')).rowCount).toBe(0);expect((await db.query('SELECT decision FROM chat_intake_requests')).rows[0]).toEqual({decision:'cancelled'});
 });
});
