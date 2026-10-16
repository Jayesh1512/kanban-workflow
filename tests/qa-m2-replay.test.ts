import { tl } from '@mtcute/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramStore } from '../src/telegram/store.js';
import { TelegramSync } from '../src/telegram/sync.js';
import { DurableControlBus } from '../src/telegram/control.js';
import type { MtcuteAdapter } from '../src/telegram/adapter.js';
import type { TelegramPort } from '../src/shared/ports.js';
import { isolatedDatabase } from './qa-m31-support.js';
import { qaSource, qaTelegramConfig } from './qa-m2-support.js';
const project=process.env['QA_M2_PROJECT'];
const bad='-1000000000100',healthy='-1000000000042',control='-1000000000001';
const ready={state:'ready' as const,code:null,detail:null,checkedAt:new Date().toISOString()};
describe.skipIf(!project)('independent M2 fair replay, actualPG state and controlled remote faults',()=> {
  let f:Awaited<ReturnType<typeof isolatedDatabase>>,store:TelegramStore;
  beforeEach(async()=> {f=await isolatedDatabase(project!,true);store=new TelegramStore(f.db,qaTelegramConfig);});
  afterEach(async()=> {vi.useRealTimers();await f?.close();});
  async function dialogs(ids=[bad,healthy,control]) {
    for(const id of ids) await store.upsertDialog({id,kind:'supergroup',title:`QA synthetic ${id}`,username:null,archived:false});
    if(ids.includes(control)) await f.db.query("UPDATE chats SET is_control=true,inclusion='excluded' WHERE id=$1",[control]);
    await f.db.query('UPDATE telegram_history_requests SET remaining_batches=0');
  }
  it.each(['history','replay','recent'] as const)('isolates inaccessible %s and control, progresses healthy chat, persists backoff and recovers later',async phase=> {
    await dialogs();
    if(phase==='history') {await f.db.query('UPDATE telegram_history_requests SET remaining_batches=1 WHERE chat_id<>$1',[control]);await f.db.query("UPDATE history_cursors SET next_message_id=90,next_date='2026-10-17T09:00:00Z' WHERE chat_id<>$1",[control]);}
    let blocked=true;const calls:Array<{id:string;kind:string}>=[];
    const transport={status:async()=>ready,loginState:async()=>({state:'ready'}),async *discoverDialogs(){},
      async getHistory(id:string,cursor:{nextMessageId:number|null}) {const kind=id===control?'control':cursor.nextMessageId===null?'replay':'history';calls.push({id,kind});if(blocked&&(id===control||(id===bad&&kind===phase)))throw new tl.RpcError(400,'CHANNEL_PRIVATE');return{messages:[qaSource(id,kind==='history'?80:101)],next:null,complete:true};},
      async replayPage(id:string){calls.push({id,kind:'replay'});if(blocked&&id===bad&&phase==='replay')throw new tl.RpcError(400,'CHANNEL_PRIVATE');return[];},
      async recent(id:string,ids:number[]){calls.push({id,kind:'recent'});if(blocked&&id===bad&&phase==='recent')throw new tl.RpcError(400,'CHANNEL_PRIVATE');return ids.map(mid=>qaSource(id,mid));}
    } as unknown as MtcuteAdapter;
    let sync=new TelegramSync(f.db,store,transport,new DurableControlBus(f.db,transport),2);
    for(let n=0;n<3;n++)await sync.tick();
    expect(await store.getLiveCheckpoint(healthy)).toMatchObject({highWaterMessageId:101});
    const before=await store.getLiveCheckpoint(bad);
    if(phase==='replay')expect(before.highWaterMessageId).toBeNull();
    if(phase==='history')expect(await store.getCursor(bad)).toMatchObject({nextMessageId:90,importedCount:0,status:'error'});
    if(phase==='recent')expect((await f.db.query('SELECT deleted_at FROM messages WHERE chat_id=$1',[bad])).rows.every(r=>r.deleted_at===null)).toBe(true);
    expect(sync.status()).toMatchObject({state:'degraded',code:'telegram_chat_retry'});expect(sync.status().detail).toContain(control);expect(sync.status().detail).toContain(bad);
    expect((await f.db.query("SELECT * FROM app_settings WHERE key=$1",[`telegram:control-replay:${control}`])).rows).toEqual([]);
    const faultCalls=calls.filter(c=>c.id===control||(c.id===bad&&c.kind===phase)).length;
    await sync.stop();const db=await f.reopen();store=new TelegramStore(db,qaTelegramConfig);sync=new TelegramSync(db,store,transport,new DurableControlBus(db,transport),2);await sync.tick();
    expect(calls.filter(c=>c.id===control||(c.id===bad&&c.kind===phase))).toHaveLength(faultCalls);
    blocked=false;
    await db.query("UPDATE app_settings SET value=jsonb_set(value,'{retryAt}',to_jsonb((now()-interval '1 second')::text)) WHERE key LIKE 'telegram:sync-retry:%'");
    await db.query("UPDATE live_checkpoints SET reconciled_at=now()-interval '61 seconds' WHERE chat_id=$1",[bad]);
    for(let n=0;n<3;n++)await sync.tick();
    expect(await store.getLiveCheckpoint(bad)).toMatchObject({highWaterMessageId:101});
    if(phase==='history')expect(await store.getCursor(bad)).toMatchObject({importedCount:1,status:'complete'});
    expect((await db.query("SELECT * FROM app_settings WHERE key LIKE 'telegram:sync-retry:%'")).rows).toEqual([]);
    expect((await db.query('SELECT message_id FROM control_inbox')).rows).toEqual([{message_id:101}]);
    expect(sync.status()).toMatchObject({state:'ready',code:null});await sync.stop();
  });
  it.each(['flood','network','database'] as const)('keeps true global %s failures global with no false coverage, then retries successfully',async kind=> {
    await dialogs([healthy]);let faults=1,calls=0;
    if(kind==='database') {
      await f.db.query('CREATE SEQUENCE qa_storage_once');
      await f.db.query("CREATE FUNCTION qa_storage_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF nextval('qa_storage_once')=1 THEN RAISE EXCEPTION 'QA actual SQL infrastructure failure' USING ERRCODE='08006'; END IF; RETURN NEW; END $$");
      await f.db.query('CREATE TRIGGER qa_storage BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION qa_storage_fault()');
    }
    const transport={status:async()=>ready,loginState:async()=>({state:'ready'}),async *discoverDialogs(){},
      async getHistory(id:string){calls++;if(kind!=='database'&&faults-->0)throw kind==='flood'?tl.RpcError.fromTl({errorCode:420,errorMessage:'FLOOD_WAIT_45'}):Error('QA synthetic connection unavailable');return{messages:[qaSource(id)],next:null,complete:true};},
      async recent(id:string,ids:number[]){return ids.map(mid=>qaSource(id,mid));}
    } as unknown as MtcuteAdapter;
    const sync=new TelegramSync(f.db,store,transport,new DurableControlBus(f.db,transport as TelegramPort),2);
    vi.useFakeTimers({toFake:['Date']});
    await expect(sync.tick()).rejects.toBeDefined();expect(sync.status()).toMatchObject({code:'telegram_sync_retry'});
    expect(await store.getLiveCheckpoint(healthy)).toMatchObject({highWaterMessageId:null,replayRequired:true});expect((await f.db.query('SELECT * FROM messages')).rows).toEqual([]);
    await sync.tick();expect(calls).toBe(1);
    vi.setSystemTime(Date.now()+(kind==='flood'?44999:9999));await sync.tick();expect(calls).toBe(1);
    vi.setSystemTime(Date.now()+1);await sync.tick();expect(calls).toBe(2);
    expect(await store.getLiveCheckpoint(healthy)).toMatchObject({highWaterMessageId:101});expect(sync.status()).toMatchObject({state:'ready'});
    expect((await f.db.query("SELECT * FROM app_settings WHERE key LIKE 'telegram:sync-retry:%'")).rows).toEqual([]);await sync.stop();
  });
  it('turns an explicit positional missing-message result into scoped deletion, not a failed-RPC guess',async()=> {
    await dialogs([healthy]);const transport={status:async()=>ready,loginState:async()=>({state:'ready'}),async getHistory(id:string){return{messages:[qaSource(id)],next:null,complete:true};},async recent(){return[null];}} as unknown as MtcuteAdapter;
    const sync=new TelegramSync(f.db,store,transport,new DurableControlBus(f.db,transport),2);await sync.tick();
    expect((await f.db.query('SELECT chat_id::text id,message_id FROM message_tombstones')).rows).toEqual([{id:healthy,message_id:101}]);
    expect((await f.db.query('SELECT deleted_at IS NOT NULL deleted FROM messages')).rows).toEqual([{deleted:true}]);expect((await f.db.query('SELECT * FROM proposals')).rows).toEqual([]);await sync.stop();
  });
});
