import { createServer, connect, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createPlatformModule } from '../src/platform/module.js';
import { PgDatabase } from '../src/platform/database.js';
import { createWorkflowModule } from '../src/workflow/module.js';
import { deferred,fixture } from './qa-m32-support.js';
import { canonicalFixture, project, sdk, value } from './qa-m4-support.js';

describe.skipIf(!project)('QA M4 real protocol and dependency status',()=> {
  it('real empty PostgreSQL schema exposes sanitized status/discovery before migrations, then initializes without provider/TG calls',async()=> {
    const h=await fixture(false),schema=`qa_m4_empty_${randomUUID().replaceAll('-','')}`,dir=await mkdtemp(join(tmpdir(),'antseed-qa-m4-empty-'));
    await h.db.query(`CREATE SCHEMA ${schema}`);const config=structuredClone(h.config),url=new URL(h.db.pool.options.connectionString!);url.searchParams.set('options',`-c search_path=${schema}`);config.databaseUrl=url.toString();config.telegram.sessionPath=join(dir,'never-authorized.session');config.jev.apiKey='QA-M4-synthetic-paused';
    const platform=await createPlatformModule(config),db=platform.services.db as PgDatabase,original=db.withLock.bind(db),release=deferred();let held=false;
    // Hold the explicit migration entry, independent of optional initial health SELECTs.
    db.withLock=async(key,work)=>{if(!held&&key==='antseed:migrations'){held=true;await release.promise;}return original(key,work);};
    const workflow=await createWorkflowModule(platform.services),app=await buildApp({modules:[platform,workflow]}),address=await app.listen({host:'127.0.0.1',port:0}),client=await sdk(address);
    try {
      const r=await app.inject('/api/status'),s=r.json();expect(r.statusCode).toBe(200);expect(s.components.database.code).toBe('database_pending');expect(s.components.jev.code).toBe('database_pending');expect(s).toHaveProperty('configuration');expect((await app.inject('/health/ready')).statusCode).toBe(503);expect((await client.listTools()).tools).toHaveLength(27);
      const call=await client.callTool({name:'list_companies',arguments:{}});expect(call.isError).toBe(true);expect(value(call).error.code).toBe('upstream_unavailable');
      expect((await h.db.query('SELECT count(*)::int n FROM pg_tables WHERE schemaname=$1',[schema])).rows).toEqual([{n:0}]);
      release.resolve();for(let i=0;i<200;i++){if((await app.inject('/api/companies')).statusCode===200)break;await delay(10);}
      expect((await app.inject('/api/companies')).json()).toEqual({items:[],nextCursor:null});expect((await platform.services.telegram.loginState()).state).toBe('disconnected');
    } finally {release.resolve();await client.close();await app.close();await h.db.query(`DROP SCHEMA ${schema} CASCADE`);await rm(dir,{recursive:true,force:true});await h.close();}
  });
  it('official SDK discovery plus raw protocol rejects REST/invalid JSON and unsupported verbs',async()=> {
    const f=await canonicalFixture(),client=await sdk(f.url);
    try {
      expect((await client.listTools()).tools).toHaveLength(27);
      for(const method of ['GET','DELETE']) {const r=await fetch(`${f.url}/mcp`,{method});expect(r.status).toBe(405);expect(r.headers.get('allow')).toBe('POST');}
      // Pinned official SDK classifies invalid JSON-RPC schema as -32700 too
      // (webStandardStreamableHttp.js), rather than generic JSON-RPC -32600.
      for(const [body,code] of [['{',-32700],[JSON.stringify({tool:'get_ticket',arguments:{id:f.h.ticket.id}}),-32700]] as const) {
        const r=await fetch(`${f.url}/mcp`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body});expect(r.status).toBe(400);expect(await r.json()).toMatchObject({jsonrpc:'2.0',error:{code}});
      }
      const notMcp=await fetch(`${f.url}/mcp`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:99,method:'tools/list',params:{}})});expect(notMcp.status).toBe(406);
    } finally {await client.close();await f.close();}
  });
  it('actual TCP PostgreSQL interruption keeps UI/live/status reachable, sanitizes both transports and recovers',async()=> {
    let online=true;const sockets=new Set<Socket>();
    const proxy=createServer((incoming)=> {
      if(!online){incoming.destroy();return;}
      const outgoing=connect({host:'127.0.0.1',port:Number(process.env['QA_M31_PG_PORT']??18433)});sockets.add(incoming);sockets.add(outgoing);
      incoming.on('error',()=>{});outgoing.on('error',()=>incoming.destroy());incoming.on('close',()=>{sockets.delete(incoming);outgoing.destroy();});outgoing.on('close',()=>{sockets.delete(outgoing);incoming.destroy();});incoming.pipe(outgoing);outgoing.pipe(incoming);
    });
    await new Promise<void>((r)=>proxy.listen(0,'127.0.0.1',r));const port=(proxy.address() as {port:number}).port;
    const f=await canonicalFixture({databasePort:port}),client=await sdk(f.url);
    try {
      for(let i=0;i<100;i++){const s=(await f.app.inject('/api/status')).json();if(s.components.jev.code==='provider_entitlement')break;await delay(10);}
      const before=(await f.app.inject('/api/status')).json();expect(before.components).toHaveProperty('workflow');expect(before.components.jev.code).toBe('provider_entitlement');expect(before).toHaveProperty('telegramLogin');expect(before).toHaveProperty('configuration');
      online=false;for(const s of sockets)s.destroy();
      for(const path of ['/','/health/live','/api/status']){const r=await fetch(`${f.url}${path}`);expect(r.status).toBe(200);const text=await r.text();expect(text).not.toContain(f.config.vikunja.password);expect(text).not.toContain(f.config.vikunja.apiToken);}
      const status=await (await fetch(`${f.url}/api/status`)).json();expect(status.components.database.state).toBe('unavailable');expect(status.components.jev).toMatchObject({state:'unavailable',code:'database_unavailable'});
      expect((await fetch(`${f.url}/health/ready`)).status).toBe(503);expect((await fetch(`${f.url}/api/companies`)).status).toBe(503);
      const failed=await client.callTool({name:'list_companies',arguments:{}});expect(failed.isError).toBe(true);expect(value(failed)).toMatchObject({error:{code:'upstream_unavailable',retryable:true}});
      expect(JSON.stringify(status)).not.toMatch(/ECONNRESET|postgresql:|PRIVATE|18433/);
      expect(JSON.stringify(status)).not.toContain(process.env['QA_M31_PG_PORT']??'18433');
      online=true;
      for(let i=0;i<100;i++){const r=await fetch(`${f.url}/api/status`);if((await r.json()).components.database.state==='ready')break;await delay(100);}
      expect((await fetch(`${f.url}/api/companies`)).status).toBe(200);expect(value(await client.callTool({name:'get_ticket',arguments:{id:f.h.ticket.id}})).id).toBe(f.h.ticket.id);
      expect((await f.h.local()).stageVersion).toBe(0);expect((await f.h.remote())?.bucketId).toBe(f.h.board.buckets['To be started']);
    } finally {online=true;await client.close();await f.close();for(const s of sockets)s.destroy();await new Promise<void>((r)=>proxy.close(()=>r()));}
  },20000);
});
