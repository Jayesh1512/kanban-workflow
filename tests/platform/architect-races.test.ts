import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parse } from 'dotenv';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PgDatabase, migrate } from '../../src/platform/database.js';
import { loadRuntimeConfig } from '../../src/platform/config.js';
import { testVikunjaToken } from '../vikunja-test-auth.js';
import { VikunjaAdapter } from '../../src/vikunja/adapter.js';
import type { RuntimeConfig } from '../../src/shared/ports.js';

const project = process.env['ARCHITECT_TEST_PROJECT'];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

// Real PostgreSQL/Vikunja only in an explicitly selected synthetic architect test project.
describe.skipIf(!project)('architect real session/projection regressions', () => {
  let db: PgDatabase, config: RuntimeConfig, adapter: VikunjaAdapter;
  beforeAll(async () => {
    if (!/^antseed-(?:arch|qa-m1-system)-[a-z0-9-]+$/.test(project!)) throw new Error('Require an explicitly isolated architect/system test project');
    const args = ['compose', '-p', project!, '-f', 'compose.yaml'];
    const override = process.env['ARCHITECT_TEST_COMPOSE_OVERRIDE'];
    if (override) args.push('-f', override);
    const bundle = parse(execFileSync('docker', [...args, 'exec', '-T', 'vikunja', 'cat', '/run/antseed/runtime.env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    config = await loadRuntimeConfig({ ...bundle, AI_ENV_PATH: '/architect-not-present', DATABASE_URL: bundle['DATABASE_URL']!.replace('postgres:5432', `127.0.0.1:${process.env['ARCHITECT_TEST_PG_PORT']}`), VIKUNJA_URL: process.env['ARCHITECT_TEST_VIKUNJA_URL']! });
    await testVikunjaToken(config.vikunja);
    db = new PgDatabase(config.databaseUrl); adapter = new VikunjaAdapter(config.vikunja, db);
    await migrate(db); await adapter.ensureBoard();
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  afterAll(async () => { await db?.close(); });
  async function fixture() {
    const company = (await db.query("INSERT INTO companies(canonical_name) VALUES('Architect regression synthetic') RETURNING id")).rows[0]!['id'] as string;
    const chat = `-${parseInt(randomUUID().replaceAll('-', '').slice(0, 10), 16)}`;
    await db.query("INSERT INTO chats(id,kind,title,inclusion,mapping_status,company_id) VALUES($1,'group','Synthetic only','included','confirmed',$2)", [chat, company]);
    const ticketId = (await db.query('INSERT INTO tickets(chat_id,company_id) VALUES($1,$2) RETURNING id', [chat, company])).rows[0]!['id'] as string;
    const input = { ticketId, title: 'Architect regression synthetic', description: 'No Telegram or model activity', workstream: 'Buyer' as const };
    return { input, task: await adapter.ensureTask(input), board: await adapter.ensureBoard() };
  }
  async function rawMove(taskId: string, projectId: string, viewId: string, bucketId: string) {
    const auth = {token:await testVikunjaToken(config.vikunja)};
    const result = await fetch(`${config.vikunja.baseUrl}/api/v2/projects/${projectId}/views/${viewId}/buckets/${bucketId}/tasks`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` }, body: JSON.stringify({ task_id: Number(taskId) }) });
    expect(result.ok).toBe(true); await result.body?.cancel();
  }

  it('projects eight distinct tickets with all eight pool clients checked out', async () => {
    const fixtures = [];
    for (let i = 0; i < 8; i++) fixtures.push(await fixture());
    const native = fetch, barrier = deferred();
    let arrivals = 0, maxWaiting = 0;
    vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
      if (args[1]?.method === 'GET' && /\/api\/v2\/tasks\/\d+$/.test(String(args[0]))) {
        if (++arrivals === 8) barrier.resolve();
        await barrier.promise;
      }
      return native(...args);
    });
    const timer = setInterval(() => { maxWaiting = Math.max(maxWaiting, db.pool.waitingCount); }, 5);
    const emergency = setTimeout(barrier.resolve, 5000);
    try {
      const results = await Promise.allSettled(fixtures.map((f) => adapter.ensureTask(f.input)));
      expect(arrivals).toBe(8);
      expect(results.map((r) => r.status)).toEqual(Array(8).fill('fulfilled'));
      expect(maxWaiting).toBe(0);
    } finally { clearInterval(timer); clearTimeout(emergency); barrier.resolve(); }
  }, 30_000);
  it('projects the same existing ticket eight times without lock-waiter pool starvation', async () => {
    const f = await fixture();
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => adapter.ensureTask(f.input)));
    expect(results.map((r) => r.status)).toEqual(Array(8).fill('fulfilled'));
  }, 30_000);
  it('reenters an outer workflow ticket lock and short transaction without a ninth pool borrower', async () => {
    const f = await fixture(), parked = deferred(), entered = deferred();
    let count = 0;
    const parking = Array.from({ length: 7 }, (_, i) => db.withSessionLock(`architect:parking:${i}`, async () => {
      if (++count === 7) entered.resolve(); await parked.promise;
    }));
    try {
      await entered.promise;
      await db.withSessionLock(`antseed:ticket:${f.input.ticketId}`, async (sql) => {
        const pid = (await sql.query('SELECT pg_backend_pid() AS pid')).rows[0]!['pid'];
        await db.transaction(async () => { expect((await db.query('SELECT pg_backend_pid() AS pid')).rows[0]!['pid']).toBe(pid); });
        await adapter.ensureTask(f.input);
        await adapter.updateTaskDetails({ taskId: f.task.id, title: 'Outer workflow lock', description: 'Short transaction ends before HTTP', workstream: 'Integration' });
        await adapter.moveTask({ taskId: f.task.id, projectId: f.board.projectId, viewId: f.board.viewId, targetBucketId: f.board.buckets.Completed });
        expect((await sql.query('SELECT pg_backend_pid() AS pid')).rows[0]!['pid']).toBe(pid);
        expect(db.pool.waitingCount).toBe(0);
      });
      expect((await adapter.getTask(f.task.id))!.bucketId).toBe(f.board.buckets.Completed);
    } finally { parked.resolve(); await Promise.allSettled(parking); }
  }, 30_000);
  it.each(['application', 'direct-remote'] as const)('preserves Completed during a paused descriptive write versus %s move', async (source) => {
    const f = await fixture(), reached = deferred(), release = deferred(), native = fetch;
    let fields: string[] = [], contentType: string | null = null;
    vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
      if (args[1]?.method === 'PATCH' && String(args[0]).endsWith(`/api/v2/tasks/${f.task.id}`)) {
        fields = Object.keys(JSON.parse(String(args[1].body)) as object).sort();
        contentType = new Headers(args[1].headers).get('Content-Type');
        reached.resolve(); await release.promise;
      }
      return native(...args);
    });
    const details = adapter.updateTaskDetails({ taskId: f.task.id, title: 'Race-safe detail', description: 'Only descriptive fields', workstream: 'Provider' }).then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
    let movement: Promise<void> | undefined;
    try {
      await Promise.race([reached.promise, delay(5000).then(() => { throw new Error('PATCH not reached'); })]);
      expect(fields).toEqual(['description', 'title']); expect(contentType).toBe('application/merge-patch+json');
      let finished = false;
      movement = (source === 'application'
        ? adapter.moveTask({ taskId: f.task.id, projectId: f.board.projectId, viewId: f.board.viewId, targetBucketId: f.board.buckets.Completed })
        : rawMove(f.task.id, f.board.projectId, f.board.viewId, f.board.buckets.Completed)).then(() => { finished = true; });
      if (source === 'application') { await delay(100); expect(finished).toBe(false); }
      else { await movement; expect((await adapter.getTask(f.task.id))!.bucketId).toBe(f.board.buckets.Completed); }
      release.resolve(); await movement;
      const result = await details;
      if (!result.ok) expect(result.error).toMatchObject({ code: 'conflict' });
      expect((await adapter.getTask(f.task.id))!.bucketId).toBe(f.board.buckets.Completed);
    } finally { release.resolve(); await Promise.allSettled([details, movement]); }
  }, 30_000);
  it('handles checked-out server-side connection loss in a child, then recovers its pool', async () => {
    const script = `
      import {PgDatabase} from './dist/platform/database.js';
      const db=new PgDatabase(process.env.ARCHITECT_DATABASE_URL);
      let rejected=false,signal;
      try {await db.withSessionLock('architect:session-loss',async(sql,s)=>{
        signal=s; console.log(JSON.stringify({pid:(await sql.query('SELECT pg_backend_pid() AS pid')).rows[0].pid}));
        await new Promise(r=>setTimeout(r,700)); await db.query('SELECT 1');
      });}catch(error){rejected=error.code==='upstream_unavailable';}
      await db.query('SELECT 1'); await db.close();
      console.log(JSON.stringify({rejected,recovered:true,aborted:signal.aborted}));
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: process.env['PATH'] ?? '', ARCHITECT_DATABASE_URL: config.databaseUrl }, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    let output = '';
    child.stdout.on('data', (data) => { output += String(data); }); child.stderr.on('data', () => {});
    try {
      for (let i = 0; i < 100 && !output.includes('\n') && child.exitCode === null; i++) await delay(20);
      const pid = (JSON.parse(output.split('\n')[0]!) as { pid: number }).pid;
      expect(Number.isSafeInteger(pid)).toBe(true);
      await db.query('SELECT pg_terminate_backend($1)', [pid]);
      const [code] = await Promise.race([exited, delay(5000).then(() => { throw new Error('Child failed to finish'); })]);
      expect(code).toBe(0);
      expect(output).toContain('"rejected":true'); expect(output).toContain('"recovered":true'); expect(output).toContain('"aborted":true');
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
  });
  it('aborts inherited HTTP and fences late transport completion after real session loss', async () => {
    const f = await fixture(), reached = deferred(), resume = deferred(), native = fetch;
    let pid = 0, signal: AbortSignal | undefined, labelCalls = 0;
    vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).includes(`/tasks/${f.task.id}/labels`)) labelCalls++;
      if (args[1]?.method === 'PATCH' && String(args[0]).endsWith(`/tasks/${f.task.id}`)) {
        signal = args[1].signal ?? undefined; reached.resolve(); await resume.promise;
        // Deliberately uncooperative transport completes AFTER cancellation; no upstream write.
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return native(...args);
    });
    const work = db.withSessionLock(`antseed:ticket:${f.input.ticketId}`, async (sql) => {
      pid = (await sql.query('SELECT pg_backend_pid() AS pid')).rows[0]!['pid'] as number;
      await adapter.updateTaskDetails({ taskId: f.task.id, title: 'Cancelled', description: 'Cancelled', workstream: 'Provider' });
    });
    const rejected = expect(work).rejects.toMatchObject({ code: 'upstream_unavailable' });
    try {
      await reached.promise;
      await db.query('SELECT pg_terminate_backend($1)', [pid]);
      await rejected; expect(signal?.aborted).toBe(true);
      resume.resolve(); await delay(20);
      expect(labelCalls).toBe(0);
      expect((await db.query('SELECT 1 AS recovered')).rows[0]!['recovered']).toBe(1);
    } finally { resume.resolve(); await rejected; }
  });
});
