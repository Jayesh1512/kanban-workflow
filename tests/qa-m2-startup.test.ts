import { DeleteMessageUpdate } from '@mtcute/node';
import { describe, expect, it, vi } from 'vitest';
import { loadRuntimeConfig } from '../src/platform/config.js';
import { settle, startupFixture } from './qa-m2-support.js';
const project=process.env['QA_M2_PROJECT'];
describe.skipIf(!project)('independent M2 resume/raw IDs, controlled clients plus actualPG',()=> {
  it('restores after transient identity outage with one owner, durable account before updates and no login code',async()=> {
    const x=await startupFixture(project!); vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']});
    try {
      await x.adapter.start(); expect(x.counts()).toMatchObject({owners:0,codes:0,updates:0}); expect(await x.adapter.status()).toMatchObject({state:'degraded',code:'saved_session_retry'});
      await Promise.all(Array.from({length:8},()=>x.adapter.start()));
      await vi.advanceTimersByTimeAsync(4999); expect(x.log.filter(v=>v==='create:auth')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1); await settle(async()=>x.counts().updates===1&&(await x.adapter.status()).state==='ready','automatic saved-session recovery');
      expect(x.counts()).toEqual({owners:1,maxOwners:1,codes:0,updates:1});
      expect(x.log.indexOf('close:auth')).toBeLessThan(x.log.indexOf('create:live'));
      expect(x.log.indexOf('discover')).toBeLessThan(x.log.indexOf('updates'));
    } finally {vi.useRealTimers();await x.close();}
  });
  it('explicit synthetic phone/code setup cancels the pending restore timer',async()=> {
    const x=await startupFixture(project!);vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']});
    try {
      await x.adapter.start(); const result=await x.adapter.submitLogin({step:'phone',phone:'+19990000001'});
      expect(result).toMatchObject({state:'code_required',phone:'***01'});expect(JSON.stringify(result)).not.toContain('+19990000001');
      const created=x.log.filter(v=>v.startsWith('create:')).length;await vi.advanceTimersByTimeAsync(300000);expect(x.log.filter(v=>v.startsWith('create:'))).toHaveLength(created);
      expect(x.counts()).toMatchObject({owners:1,maxOwners:1,codes:1,updates:0});
      expect(await x.adapter.submitLogin({step:'code',code:'QA-SYNTHETIC-CODE'})).toMatchObject({state:'ready'}); expect(x.counts().maxOwners).toBe(1);
    } finally {vi.useRealTimers();await x.close();}
  });
  it('stop cancels a scheduled retry and leaves no session owner',async()=> {
    const x=await startupFixture(project!);vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']});
    try {await x.adapter.start();await x.adapter.stop();await vi.advanceTimersByTimeAsync(3600000);expect(x.log.filter(v=>v.startsWith('create:'))).toEqual(['create:auth']);expect(x.counts().owners).toBe(0);}
    finally {vi.useRealTimers();await x.close();}
  });
  it('stop during a blocked retry fences later identity and catch-up work',async()=> {
    const x=await startupFixture(project!);let release!:()=>void;vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']});
    try {
      await x.adapter.start();x.gate(new Promise<void>(r=>{release=r;}));await vi.advanceTimersByTimeAsync(5000);
      const stopping=x.adapter.stop();release();await stopping;await vi.advanceTimersByTimeAsync(60000);
      expect(x.log.filter(v=>v==='identity:auth')).toHaveLength(1);expect(x.counts()).toMatchObject({owners:0,updates:0,codes:0,maxOwners:1});
    } finally {release?.();vi.useRealTimers();await x.close();}
  });
  it('raw TooLong42 marks only channel -1000000000042 and preserves already-marked delete scope',async()=> {
    const x=await startupFixture(project!,0);
    try {
      for(const id of ['42','-1000000000042']) await x.store.upsertDialog({id,kind:id==='42'?'user':'supergroup',title:'QA raw ID collision',username:null,archived:false});
      await x.adapter.start();await settle(async()=>(await x.store.getLiveCheckpoint('42')).generation>0,'initial durable reconnect');
      await x.f.db.query('UPDATE live_checkpoints SET replay_required=false,generation=0');x.tooLong(42);
      await settle(async()=>(await x.store.getLiveCheckpoint('-1000000000042')).generation===1,'channel-scoped gap');
      expect(await x.store.getLiveCheckpoint('42')).toMatchObject({replayRequired:false,generation:0});
      x.deleted(new DeleteMessageUpdate({_: 'updateDeleteChannelMessages',channelId:42,messages:[101],pts:1,ptsCount:1}));
      await settle(async()=>(await x.f.db.query('SELECT * FROM message_tombstones')).rows.length===1,'channel-scoped native delete');
      expect((await x.f.db.query('SELECT chat_id::text id,message_id FROM message_tombstones')).rows).toEqual([{id:'-1000000000042',message_id:101}]);
    } finally {await x.close();}
  });
  it('default published profile on a fresh session performs no native construction, code request or account bind',async()=> {
    const cfg=await loadRuntimeConfig({AI_ENV_PATH:'/qa-no-private-ai-env'});expect(cfg.telegram.apiId).toBeGreaterThan(0);expect(cfg.telegram.apiHash?.length).toBeGreaterThan(0);
    const x=await startupFixture(project!,0,cfg.telegram,false);
    try {await x.f.db.query('DELETE FROM telegram_account');await x.adapter.start();expect(x.log).toEqual([]);expect(x.counts()).toEqual({owners:0,maxOwners:0,codes:0,updates:0});expect(await x.adapter.authorizedSelf()).toBeNull();expect((await x.f.db.query('SELECT * FROM telegram_account')).rows).toEqual([]);expect(await x.adapter.loginState()).toMatchObject({state:'disconnected'});}
    finally{await x.close();}
  });
  it('a complete custom application override stays paired; fresh start is idle until explicit synthetic phone setup',async()=> {
    const cfg=await loadRuntimeConfig({AI_ENV_PATH:'/qa-no-private-ai-env',TELEGRAM_APPLICATION_PROFILE:'custom',TELEGRAM_API_ID:'456789',TELEGRAM_API_HASH:'QA-CUSTOM-APPLICATION-HASH'});
    expect(cfg.telegram.apiId===456789&&cfg.telegram.apiHash==='QA-CUSTOM-APPLICATION-HASH').toBe(true);
    const x=await startupFixture(project!,0,cfg.telegram,false);
    try {await x.adapter.start();expect(x.log).toEqual([]);expect(await x.adapter.submitLogin({step:'phone',phone:'+19990000001'})).toMatchObject({state:'code_required'});expect(x.counts()).toMatchObject({codes:1,owners:1,updates:0});expect(JSON.stringify(await x.adapter.status())).not.toContain(cfg.telegram.apiHash!);}
    finally{await x.close();}
  });
  it('empty custom profile stays unconfigured and partial credentials cannot borrow the published half',async()=> {
    const cfg=await loadRuntimeConfig({AI_ENV_PATH:'/qa-no-private-ai-env',TELEGRAM_APPLICATION_PROFILE:'custom'});expect(cfg.telegram).toMatchObject({apiId:null,apiHash:null});
    const x=await startupFixture(project!,0,cfg.telegram,false);
    try {await x.adapter.start();await expect(x.adapter.submitLogin({step:'phone',phone:'+19990000001'})).rejects.toMatchObject({code:'not_configured'});expect(x.log).toEqual([]);}
    finally{await x.close();}
    await expect(loadRuntimeConfig({AI_ENV_PATH:'/qa-no-private-ai-env',TELEGRAM_API_ID:'456789'})).rejects.toThrow('both');
  });

});
