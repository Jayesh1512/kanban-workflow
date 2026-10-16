import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { User, SentCode } from '@mtcute/node';
import type { DeleteMessageUpdate, TelegramClient } from '@mtcute/node';
import { MtcuteAdapter } from '../src/telegram/adapter.js';
import type { TelegramMessageInput } from '../src/shared/ports.js';
import { TelegramStore } from '../src/telegram/store.js';
import { isolatedDatabase, sourceInput } from './qa-m31-support.js';
export const qaTelegramConfig={apiId:1,apiHash:'QA-SYNTHETIC-NOT-A-REAL-HASH',sessionPath:':memory:',historyBatchSize:2,historyMaxBatches:2};
export function qaSource(chatId=sourceInput('rel-028',1).chat.id,id=101):TelegramMessageInput {
  const m=sourceInput('rel-028',1).messages[0]!;
  return {...m,chatId,id,sentAt:new Date(m.sentAt).toISOString(),peer:{...m.peer,id:chatId}};
}
/** Native-client seam only. Marker is not a SQLite session and no remote auth occurs. */
export async function startupFixture(project:string,failures=1,application: {apiId:number|null;apiHash:string|null}=qaTelegramConfig,existing=true) {
  const f=await isolatedDatabase(project,true),store=new TelegramStore(f.db,qaTelegramConfig);
  const directory=await mkdtemp(join(tmpdir(),'antseed-qa-m2-')),sessionPath=join(directory,'synthetic.session'); if(existing) await writeFile(sessionPath,'Synthetic existence marker, never a real Telegram session');
  const log:string[]=[]; let owners=0,maxOwners=0,codes=0,updates=0;
  let gate:Promise<void>|null=null,tooLong:((id:number)=>void)|undefined,deleted:((v:DeleteMessageUpdate)=>void)|undefined;
  const self=new User({_: 'user',id:990000099,self:true,firstName:'QA synthetic account'});
  const adapter=new MtcuteAdapter({...qaTelegramConfig,...application,sessionPath},store,(mode,onTooLong)=> {
    log.push(`create:${mode}`); if(owners!==0) throw Error('Overlapping synthetic session owners'); tooLong=onTooLong; let open=false;
    const emitter={add(_fn:unknown){}};
    return { async prepare(){if(!open){open=true;owners++;maxOwners=Math.max(maxOwners,owners);} if(gate) await gate;},
      async destroy(){if(open){open=false;owners--;} log.push(`close:${mode}`);},async stopUpdatesLoop(){},
      async getMe(){log.push(`identity:${mode}`); if(failures-->0) throw Error('QA transient identity connection failure'); return self;},
      async *iterDialogs(){log.push('discover');},
      async notifyLoggedIn(){ if((await f.db.query('SELECT self_user_id::text id FROM telegram_account')).rows[0]!.id!=='990000099') throw Error('Catch-up before durable identity'); updates++;log.push('updates'); },
      async sendCode(){codes++;return new SentCode({_: 'auth.sentCode',type:{_: 'auth.sentCodeTypeApp',length:5},phoneCodeHash:'QA-FAKE-CODE-HASH',timeout:60});},async signIn(){return self;},
      onNewMessage:emitter,onEditMessage:emitter,onDeleteMessage:{add(fn:typeof deleted){deleted=fn;}},onConnectionState:emitter,onError:emitter } as unknown as TelegramClient;
  });
  adapter.subscribe(event=>store.ingest(event));
  return {f,store,adapter,log,counts:()=>({owners,maxOwners,codes,updates}),gate(value:Promise<void>){gate=value;},tooLong(id:number){tooLong!(id);},deleted(update:DeleteMessageUpdate){deleted!(update);},async close(){await adapter.stop();await f.close();await rm(directory,{recursive:true,force:true});}};
}
export async function settle(check:()=>Promise<boolean>,label:string) {
  const started=performance.now();
  while(performance.now()-started<5000) { if(await check()) return; await new Promise<void>(resolve=>setImmediate(resolve)); }
  throw Error(`Timed out waiting for ${label}`);
}
