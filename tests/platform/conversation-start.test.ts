import { expect,it } from 'vitest';
import type { TelegramClient } from '@mtcute/node';
import { MtcuteAdapter } from '../../src/telegram/adapter.js';
import type { TelegramStore } from '../../src/telegram/store.js';
const cutoff='2026-10-04T18:30:00Z';
async function probe(options:{at?:string;kind?:'user'|'chat';hidden?:boolean;migrated?:boolean;empty?:boolean;minId?:number;creation?:boolean}){
 let fullReads=0;const calls:unknown[]=[];
 const client={async getHistory(...args:unknown[]){calls.push(args);return options.empty?[]:[{id:1,date:new Date(options.at??'2026-10-06T00:00:00Z'),chat:{id:-10042,type:options.kind??'user'},raw:options.creation?{_:'messageService',action:{_:'messageActionChatCreate'}}:{_:'message'}}];},async getFullChat(){fullReads++;return {hasHiddenHistory:options.hidden??false,historyMinId:options.minId??0,migratedFrom:options.migrated?{chatId:-42,msgId:9}:null};}} as unknown as TelegramClient;
 const adapter=new MtcuteAdapter({apiId:null,apiHash:null,sessionPath:':memory:',historyBatchSize:100,historyMaxBatches:1},{} as TelegramStore);adapter.requireLive=()=>client;
 try{return {result:await adapter.conversationStart('7',cutoff),calls,fullReads};}finally{await adapter.stop();}
}
it('probes the oldest accessible history position, never last activity or discovery date',async()=>{
 const p=await probe({});expect(p.calls).toEqual([[7,{reverse:true,offset:{id:1,date:0},limit:1}]]);expect(p.result).toMatchObject({at:'2026-10-06T00:00:00.000Z',uncertain:false});
});
it('accepts a visible new group history but treats hidden/min-ID/migrated boundaries as unknown',async()=>{
 expect((await probe({kind:'chat'})).result.uncertain).toBe(false);
 expect((await probe({kind:'chat',hidden:true,creation:true})).result.uncertain).toBe(false);
 expect((await probe({kind:'chat',migrated:true,creation:true})).result.uncertain).toBe(true);
 for(const options of [{hidden:true},{minId:25},{migrated:true}])expect((await probe({kind:'chat',...options})).result.uncertain).toBe(true);
});
it('old source history excludes without more group RPCs; empty history cannot establish a start date',async()=>{
 const old=await probe({kind:'chat',at:'2020-01-01T00:00:00Z'});expect(old.result.uncertain).toBe(false);expect(old.fullReads).toBe(0);expect((await probe({empty:true})).result).toMatchObject({at:null,uncertain:true,reason:'empty_history'});
});
