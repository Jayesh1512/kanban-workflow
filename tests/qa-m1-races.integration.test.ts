import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { parse } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDatabase } from '../src/platform/database.js';
import { loadRuntimeConfig } from '../src/platform/config.js';
import { VikunjaAdapter } from '../src/vikunja/adapter.js';
import type { RuntimeConfig } from '../src/shared/ports.js';

const project = process.env['QA_M1_PROJECT'];
describe.skipIf(!project)('independent real M1 adversarial session/projection checks', () => {
  let db: PgDatabase, config: RuntimeConfig, adapter: VikunjaAdapter;
  beforeAll(async () => {
    if (!/^antseed-qa-m1-[a-z0-9-]+$/.test(project!)) throw new Error('Require own isolated QA project');
    const bundle = parse(execFileSync('docker', ['compose', '-p', project!, '-f', 'compose.yaml', 'exec', '-T', 'backend', 'cat', '/run/antseed/runtime.env'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
    config = await loadRuntimeConfig({ ...bundle, AI_ENV_PATH: '/qa-not-present', DATABASE_URL: bundle['DATABASE_URL']!.replace('postgres:5432', `127.0.0.1:${process.env['QA_M1_PG_PORT'] ?? '18433'}`), VIKUNJA_URL: `http://127.0.0.1:${process.env['VIKUNJA_PORT'] ?? '18081'}` });
    db = new PgDatabase(config.databaseUrl); adapter = new VikunjaAdapter(config.vikunja, db);
  });
  afterAll(async () => { await db?.close(); });
  async function fixture() {
    const company = (await db.query("INSERT INTO companies(canonical_name) VALUES('QA race synthetic') RETURNING id")).rows[0]!['id'] as string;
    const chat = `-${parseInt(randomUUID().replaceAll('-', '').slice(0, 10), 16)}`;
    await db.query("INSERT INTO chats(id,kind,title,inclusion,mapping_status,company_id) VALUES($1,'group','QA race synthetic','included','confirmed',$2)", [chat, company]);
    const ticket = (await db.query('INSERT INTO tickets(chat_id,company_id) VALUES($1,$2) RETURNING id', [chat, company])).rows[0]!['id'] as string;
    const input = { ticketId: ticket, title: 'QA race synthetic', description: 'Independent fault injection only', workstream: 'Buyer' as const };
    return { input, task: await adapter.ensureTask(input), board: await adapter.ensureBoard() };
  }

  it('completes eight simultaneous existing task projections without pool starvation', async () => {
    const { input, task } = await fixture();
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => adapter.ensureTask(input)));
    expect(results.map((r) => r.status)).toEqual(Array(8).fill('fulfilled'));
    expect(results.flatMap((r) => r.status === 'fulfilled' ? [r.value.id] : [])).toEqual(Array(8).fill(task.id));
  }, 30_000);

  it('serializes a delayed descriptive PUT/PATCH against a concurrent application movement', async () => {
    const { task, board } = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const delayedPut = new Promise<void>((resolve) => { reached = resolve; });
    const proxy = http.createServer(async (request, response) => {
      try {
        const parts: Buffer[] = [];
        for await (const part of request) parts.push(Buffer.from(part));
        const body = Buffer.concat(parts);
        if (['PUT', 'PATCH'].includes(request.method ?? '') && request.url === `/api/v2/tasks/${task.id}`) { reached(); await gate; }
        const headers = { ...request.headers }; delete headers['host']; delete headers['connection'];
        const upstream = await fetch(`${config.vikunja.baseUrl}${request.url}`, { method: request.method ?? 'GET', headers: headers as Record<string, string>, ...(body.length ? { body } : {}), signal: AbortSignal.timeout(5_000) });
        response.writeHead(upstream.status, { 'Content-Type': 'application/json' }); response.end(Buffer.from(await upstream.arrayBuffer()));
      } catch { response.writeHead(502); response.end('{}'); }
    });
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
    const address = proxy.address(); if (!address || typeof address === 'string') throw new Error('No QA proxy port');
    const delayed = new VikunjaAdapter({ ...config.vikunja, baseUrl: `http://127.0.0.1:${address.port}` }, db);
    let details: ReturnType<VikunjaAdapter['updateTaskDetails']> | undefined;
    let movement: ReturnType<VikunjaAdapter['moveTask']> | undefined;
    try {
      details = delayed.updateTaskDetails({ taskId: task.id, title: 'QA delayed description', description: 'Synthetic delayed full PUT', workstream: 'Integration' });
      await Promise.race([delayedPut, delay(5_000).then(() => { throw new Error('No delayed descriptive PUT reached proxy'); })]);
      let movedBeforeRelease = false;
      movement = adapter.moveTask({ taskId: task.id, projectId: board.projectId, viewId: board.viewId, targetBucketId: board.buckets.Completed }).then(() => { movedBeforeRelease = true; });
      await delay(500); // Let an unfenced movement race; a correctly serialized one waits.
      expect(movedBeforeRelease, 'Application move waits while descriptive write owns the session lock').toBe(false);
      release();
      const results = await Promise.allSettled([details, movement]);
      expect(results[1]?.status).toBe('fulfilled');
      if (results[0]?.status === 'rejected') expect((results[0].reason as { code?: string }).code).toBe('conflict');
      expect((await adapter.getTask(task.id))?.bucketId).toBe(board.buckets.Completed);
    } finally {
      release(); await Promise.allSettled([details, movement]);
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it('does not undo a direct remote Completed move while its descriptive PUT/PATCH is paused', async () => {
    const { task, board } = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const delayedWrite = new Promise<void>((resolve) => { reached = resolve; });
    const proxy = http.createServer(async (request, response) => {
      try {
        const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part));
        const body = Buffer.concat(parts);
        if (['PUT', 'PATCH'].includes(request.method ?? '') && request.url === `/api/v2/tasks/${task.id}`) { reached(); await gate; }
        const headers = { ...request.headers }; delete headers['host']; delete headers['connection'];
        const upstream = await fetch(`${config.vikunja.baseUrl}${request.url}`, { method: request.method ?? 'GET', headers: headers as Record<string, string>, ...(body.length ? { body } : {}), signal: AbortSignal.timeout(5_000) });
        response.writeHead(upstream.status, { 'Content-Type': 'application/json' }); response.end(Buffer.from(await upstream.arrayBuffer()));
      } catch { response.writeHead(502); response.end('{}'); }
    });
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
    const address = proxy.address(); if (!address || typeof address === 'string') throw new Error('No QA proxy port');
    const delayed = new VikunjaAdapter({ ...config.vikunja, baseUrl: `http://127.0.0.1:${address.port}` }, db);
    let details: ReturnType<VikunjaAdapter['updateTaskDetails']> | undefined;
    try {
      details = delayed.updateTaskDetails({ taskId: task.id, title: 'QA hostile remote interleaving', description: 'Synthetic source fields only', workstream: 'Integration' });
      await Promise.race([delayedWrite, delay(5_000).then(() => { throw new Error('Descriptive write not intercepted'); })]);
      const login = await fetch(`${config.vikunja.baseUrl}/api/v2/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: config.vikunja.username, password: config.vikunja.password }) });
      expect(login.status).toBe(200); const { token } = await login.json() as { token: string };
      const moved = await fetch(`${config.vikunja.baseUrl}/api/v2/projects/${board.projectId}/views/${board.viewId}/buckets/${board.buckets.Completed}/tasks`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ task_id: Number(task.id) }) });
      expect(moved.status).toBe(200); await moved.arrayBuffer();
      expect((await adapter.getTask(task.id))?.bucketId).toBe(board.buckets.Completed);
      release();
      const [result] = await Promise.allSettled([details]);
      if (result?.status === 'rejected') expect((result.reason as { code?: string }).code).toBe('conflict');
      expect((await adapter.getTask(task.id))?.bucketId).toBe(board.buckets.Completed);
    } finally {
      release(); await Promise.allSettled([details]);
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it('survives termination of its checked-out PostgreSQL lock session during a remote wait', async () => {
    // Child isolation makes an unhandled pg error observable without killing Vitest.
    const script = `
      import {PgDatabase} from './dist/platform/database.js';
      const db=new PgDatabase(process.env.QA_TEST_DATABASE_URL);
      let rejected=false;
      try { await db.withLock('qa-session-failure',async(client)=>{
        const pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        console.log(JSON.stringify({pid})); await new Promise(r=>setTimeout(r,700));
        await client.query('SELECT 1');
      }); } catch { rejected=true; }
      await db.query('SELECT 1'); await db.close();
      console.log(JSON.stringify({rejected,recovered:true}));
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), env: { PATH: process.env['PATH'] ?? '', QA_TEST_DATABASE_URL: config.databaseUrl }, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    let output = '';
    child.stdout.on('data', (data) => { output += String(data); });
    child.stderr.on('data', () => {}); // No raw child error/connection object enters reports.
    try {
      for (let n = 0; n < 100 && !output.includes('\n') && child.exitCode === null; n++) await delay(20);
      const pid = (JSON.parse(output.split('\n')[0]!) as { pid: number }).pid;
      expect(Number.isSafeInteger(pid)).toBe(true);
      await db.query('SELECT pg_terminate_backend($1)', [pid]);
      const [code] = await Promise.race([exited, delay(5_000).then(() => { throw new Error('QA child failed to finish'); })]);
      expect(code, 'checked-out client failure must not crash the process').toBe(0);
      expect(output.includes('"rejected":true')).toBe(true);
      expect(output.includes('"recovered":true')).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    }
  });
});
