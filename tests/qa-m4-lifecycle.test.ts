import { setTimeout as delay } from 'node:timers/promises';
import type { QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';
import { deferred } from './qa-m32-support.js';
import { canonicalFixture, project, sdk } from './qa-m4-support.js';

describe.skipIf(!project)('QA M4 actual app.close with official SDK and HTTP in flight', () => {
  it('preClose interrupts MCP, awaits both captured real domain reads, and closes platform DB last', async () => {
    const f = await canonicalFixture(), client = await sdk(f.url), db = f.platform.services.db;
    const original = db.query.bind(db), enteredMcp = deferred(), enteredHttp = deferred(), releaseMcp = deferred(), releaseHttp = deferred(), finishedMcp = deferred();
    const close = db.close.bind(db); let databaseClosed = false, closingDone = false, mcpSettled = false, stopsSettled = false;
    db.close = async () => { databaseClosed = true; return close(); };
    db.query = async <R extends QueryResultRow>(sql: string, args?: unknown[]) => {
      const result = await original<R>(sql,args);
      if (sql.startsWith('SELECT * FROM companies WHERE') && args?.[1] === '%qa-held-mcp%') { enteredMcp.resolve(); await releaseMcp.promise; await original('SELECT 1'); finishedMcp.resolve(); }
      if (sql.startsWith('SELECT * FROM companies WHERE') && args?.[1] === '%qa-held-http%') { enteredHttp.resolve(); await releaseHttp.promise; await original('SELECT 1'); }
      return result;
    };
    const mcp = client.callTool({name:'list_companies',arguments:{query:'qa-held-mcp'}}).then(() => {mcpSettled=true;}, () => {mcpSettled=true;});
    const http = fetch(`${f.url}/api/companies?query=qa-held-http`);
    let closing: Promise<void> | undefined;
    try {
      await Promise.all([enteredMcp.promise,enteredHttp.promise]);
      closing = f.app.close().then(() => { closingDone=true; });
      for(let i=0;i<100 && !mcpSettled;i++) await delay(10);
      expect(mcpSettled,'MCP client must not prevent shutdown from beginning').toBe(true);
      const bothStops = Promise.all([f.workflow.stop(),f.workflow.stop()]).then(() => {stopsSettled=true;});
      await delay(20);expect(databaseClosed).toBe(false);expect(closingDone).toBe(false);expect(stopsSettled).toBe(false);
      releaseMcp.resolve();await finishedMcp.promise;await delay(20);expect(databaseClosed).toBe(false);expect(closingDone).toBe(false);expect(stopsSettled).toBe(false);
      releaseHttp.resolve();expect((await http).status).toBe(200);await bothStops;
      await Promise.race([closing,delay(3000).then(()=>{throw new Error('Actual app.close did not complete');})]);expect(databaseClosed).toBe(true);expect(closingDone).toBe(true);
    } finally {
      releaseMcp.resolve();releaseHttp.resolve();await mcp;await http.catch(()=>{});await client.close();
      // Emergency cleanup only, after the assertions above; cannot turn a failed gate green.
      f.app.server.closeAllConnections();await f.workflow.stop();await closing;await f.close();
    }
  },15000);
});
