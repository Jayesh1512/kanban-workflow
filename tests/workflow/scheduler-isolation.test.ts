import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisInput } from '../../src/shared/domain.js';
import type { Database, ProviderResult } from '../../src/shared/ports.js';
import { loadRuntimeConfig } from '../../src/platform/config.js';
import { createWorkflowModule } from '../../src/workflow/module.js';
import { fixtureDatabase, seedJob } from './database.js';
const hooks = vi.hoisted(() => ({ extract: vi.fn(), project: vi.fn() }));
vi.mock('../../src/intelligence/openai.js', () => ({ createOpenAIExtractor: () => ({ extract: hooks.extract, status: async () => ({ state: 'ready', code: null, detail: null, checkedAt: new Date().toISOString() }) }) }));
vi.mock('../../src/workflow/projection.js', () => ({ TicketProjector: class { projectBatch = hooks.project; } }));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function until(test: () => boolean) { for(let n=0;n<100&&!test();n++) await delay(30); expect(test()).toBe(true); }
const releases: Array<() => void> = []; let db: Database | undefined; let module: Awaited<ReturnType<typeof createWorkflowModule>> | undefined; let app: ReturnType<typeof Fastify> | undefined;
afterEach(async () => { for(const release of releases.splice(0))release(); await module?.stop(); await app?.close(); await db?.close(); hooks.extract.mockReset(); hooks.project.mockReset(); });
async function harness(drift = false) {
  db = await fixtureDatabase();
  await db.query('CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum text NOT NULL)');
  const directory = new URL('../../db/migrations/', import.meta.url);
  for(const version of (await readdir(directory)).filter(n => /^\d[\w.-]*\.sql$/.test(n))) {
    const checksum = createHash('sha256').update(await readFile(new URL(version,directory))).digest('hex');
    await db.query('INSERT INTO schema_migrations VALUES($1,$2)',[version,drift?'0'.repeat(64):checksum]);
  }
  const config = await loadRuntimeConfig({ AI_ENV_PATH: '/synthetic-no-env', MOVEMENT_PROVIDER: 'openai', OPENAI_API_KEY: 'synthetic-not-used', OPENAI_TIMEOUT_MS: '1000' });
  function unused<T extends object>(): T { return new Proxy({} as T, { get() { throw Error('No upstream calls in scheduler boundary test'); } }); }
  module = await createWorkflowModule({ db, config, clock: { now:()=>new Date() }, vikunja: unused(), telegram: unused(), chats: unused(), ingestion: unused(), control: { subscribe:()=>()=>{}, enqueueProposal:async()=>{throw Error('No control sends');} } });
  app = Fastify(); await module.register(app); await module.start(); return { db, module };
}
describe('actual workflow scheduler with local SQL and explicitly held synthetic extraction', () => {
  it.each(['outreach','tracked reply'] as const)('processes fresh %s and keeps projection ticking while historical extraction is held; stop drains both', async mode => {
    const old = deferred(), live = deferred(); releases.push(old.resolve, live.resolve); let oldStarted = false, liveStarted = false; const signals: AbortSignal[] = [];
    hooks.project.mockResolvedValue(0);
    hooks.extract.mockImplementation(async (input: AnalysisInput, signal: AbortSignal): Promise<ProviderResult<never>> => {
      signals.push(signal);
      if(input.chat.id==='-1001'){ oldStarted=true; await old.promise; } else { liveStarted=true; await live.promise; }
      return { ok:false,code:'unavailable',retryable:true,retryAt:null,detail:'Synthetic provider deliberately held, no model called' };
    });
    const h = await harness(); await until(()=>oldStarted);
    await h.db.query("INSERT INTO chats(id,kind,title,inclusion) VALUES(-1002,'group','Synthetic new prospect','included')");
    if(mode==='tracked reply'){
      await h.db.query("INSERT INTO tickets(chat_id,company_id,kind,lane) VALUES(-1002,NULL,'contact_prospect','Work in progress')");
      await h.db.query("INSERT INTO messages(chat_id,id,sender_id,sent_at,text) VALUES(-1002,1,99,$1,'Old synthetic outreach')",[new Date(Date.now()-7200000)]);
    }
    await h.db.query("INSERT INTO messages(chat_id,id,sender_id,sent_at,text) VALUES(-1002,2,$2,$1,'Synthetic live conversation')",[new Date(),mode==='outreach'?99:7]);
    await seedJob(h.db,randomUUID(),'-1002',2); await until(()=>liveStarted);
    // Even this test's configured 1-second small-request timeout must reserve
    // enough ownership for two extended large-context attempts plus drainage.
    const leases=(await h.db.query("SELECT extract(epoch FROM (lease_until-updated_at))::int seconds FROM analysis_jobs WHERE status='running'")).rows;
    expect(leases).toHaveLength(2);expect(leases.every(r=>Number(r.seconds)>=420)).toBe(true);
    expect(oldStarted).toBe(true); const phases = hooks.project.mock.calls.length; await delay(1150); expect(hooks.project.mock.calls.length).toBeGreaterThan(phases);
    const stopping = h.module.stop(); expect(h.module.stop()).toBe(stopping); let stopped=false; void stopping.then(()=>{stopped=true;});
    await delay(30); expect(stopped).toBe(false); expect(signals.every(s=>s.aborted)).toBe(true);
    const stoppedPhases = hooks.project.mock.calls.length; live.resolve(); await delay(30); expect(stopped).toBe(false);
    old.resolve(); await stopping; expect(stopped).toBe(true); await delay(1100); expect(hooks.project.mock.calls.length).toBe(stoppedPhases); expect(hooks.extract).toHaveBeenCalledTimes(2);
  },15000);
  it('blocks both analysis slots and projection under exact migration checksum drift', async () => {
    hooks.project.mockResolvedValue(0); const h = await harness(true); await delay(1200);
    expect(hooks.extract).not.toHaveBeenCalled(); expect(hooks.project).not.toHaveBeenCalled(); expect(await h.module.status()).toMatchObject({code:'migration_drift'});
  },15000);
});
