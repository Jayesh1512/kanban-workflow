import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDatabase, migrate } from '../src/platform/database.js';
import { loadRuntimeConfig } from '../src/platform/config.js';
import { VikunjaAdapter } from '../src/vikunja/adapter.js';
import type { RuntimeConfig } from '../src/shared/ports.js';

const project = process.env['QA_M1_PROJECT'];
describe.skipIf(!project)('independent QA M1 actual PostgreSQL/Vikunja and HTTP', () => {
  let db: PgDatabase, config: RuntimeConfig, adapter: VikunjaAdapter, token: string;
  let secrets: string[];
  const backend = `http://127.0.0.1:${process.env['BACKEND_PORT'] ?? '18080'}`;
  const vikunja = `http://127.0.0.1:${process.env['VIKUNJA_PORT'] ?? '18081'}`;
  const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const compose = (...args: string[]) => docker('compose', '-p', project!, '-f', 'compose.yaml', ...args);
  async function api(path: string, method = 'GET', body?: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(`${vikunja}/api/v2${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5_000) });
    expect(response.ok, `Vikunja ${method} ${path} status`).toBe(true);
    return response.status === 204 ? {} : await response.json() as Record<string, unknown>;
  }
  beforeAll(async () => {
    if (!/^antseed-qa-m1-[a-z0-9-]+$/.test(project!)) throw new Error('Require a unique isolated antseed-qa-m1-* project');
    const container = compose('ps', '-q', 'backend').trim();
    const inspected = JSON.parse(docker('inspect', container)) as Array<{ Config: { Cmd: string[]; Labels: Record<string, string> }; Mounts: Array<{ Destination: string; Name?: string; RW: boolean }> }>;
    expect(inspected[0]!.Config.Labels['com.docker.compose.project']).toBe(project);
    expect(inspected[0]!.Config.Cmd).toEqual(['node', 'dist/main.js']);
    expect(inspected[0]!.Mounts.find((m) => m.Destination === '/run/config/ai.env')?.RW).toBe(false);
    for (const mount of inspected[0]!.Mounts.filter((m) => m.Name)) expect(mount.Name!.startsWith(`${project}_`)).toBe(true);
    // Credentials stay in memory; boolean assertions never echo their contents.
    const bundle = parse(compose('exec', '-T', 'backend', 'cat', '/run/antseed/runtime.env'));
    secrets = Object.entries(bundle).filter(([k]) => /PASSWORD|SECRET/.test(k)).map(([, v]) => v);
    config = await loadRuntimeConfig({ ...bundle, AI_ENV_PATH: '/qa-not-present', DATABASE_URL: bundle['DATABASE_URL']!.replace('postgres:5432', `127.0.0.1:${process.env['QA_M1_PG_PORT'] ?? '18433'}`), VIKUNJA_URL: vikunja });
    db = new PgDatabase(config.databaseUrl);
    adapter = new VikunjaAdapter(config.vikunja, db);
    const login = await fetch(`${vikunja}/api/v2/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: config.vikunja.username, password: config.vikunja.password }) });
    expect(login.status).toBe(200);
    token = (await login.json() as { token: string }).token;
  });
  afterAll(async () => { await db?.close(); });

  it('serves canonical M1 health and honest setup/status without credentials', async () => {
    const info = await api('/info');
    expect((info['auth'] as { local: { registration_enabled: boolean } }).local.registration_enabled).toBe(false);
    const registration = await fetch(`${vikunja}/api/v2/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'qa_must_not_register', email: 'qa-registration@localhost.invalid', password: 'QA-SYNTHETIC-NOT-A-REAL-PASSWORD' }) });
    expect(registration.status).toBe(404); // Pinned 2.7.0 does not register this route when disabled.
    const live = await fetch(`${backend}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'ok', service: 'antseed-kanban' });
    const ready = await fetch(`${backend}/health/ready`);
    expect(ready.status).toBe(503);
    const readiness = await ready.json() as { modules: Array<{ name: string; state: string; code: string }> };
    expect(readiness.modules).toMatchObject([{ name: 'platform', state: 'degraded', code: 'telegram_m2_pending' }]);
    const statusResponse = await fetch(`${backend}/api/status`);
    expect(statusResponse.headers.get('cache-control')).toBe('no-store');
    const statusText = await statusResponse.text();
    const status = JSON.parse(statusText);
    expect(status.components.database.state).toBe('ready');
    expect(status.components.vikunja.state).toBe('ready');
    expect(status.components.telegram.code).toBe('telegram_m2_pending');
    for (const provider of ['extraction', 'jev']) expect(status.components[provider]).toMatchObject({ state: 'degraded', code: 'not_checked' });
    expect(status).toMatchObject({ accountBound: false, imports: [], replayPending: 0, analysisPending: 0, proposalsPending: 0 });
    const page = await fetch(`${backend}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('no-store');
    const pageText = await page.text();
    expect(pageText).toContain('No Telegram messages are being read or sent.');
    for (const secret of [...secrets, token]) expect((statusText + pageText).includes(secret), 'credential absent from public setup/status').toBe(false);
    const pending = await fetch(`${backend}/api/telegram/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ step: 'code', code: 'SYNTHETIC-NOT-A-REAL-CODE' }) });
    expect(pending.status).toBe(503);
    expect((await pending.json() as { error: { code: string } }).error.code).toBe('not_configured');
  });

  it('actually waits on the PostgreSQL migration advisory lock before changing a schema', async () => {
    const schema = `qa_${randomUUID().replaceAll('-', '')}`;
    const directory = await mkdtemp(join(tmpdir(), 'antseed-qa-m1-lock-'));
    await db.query(`CREATE SCHEMA ${schema}`);
    const uri = new URL(config.databaseUrl); uri.searchParams.set('options', `-csearch_path=${schema}`);
    const contender = new PgDatabase(uri.toString());
    const holder = await db.pool.connect();
    let pending: Promise<void> | undefined;
    try {
      await writeFile(join(directory, '001_qa.sql'), 'CREATE TABLE qa_lock_probe(id integer PRIMARY KEY); INSERT INTO qa_lock_probe VALUES(1);');
      await holder.query("SELECT pg_advisory_lock(hashtextextended('antseed:migrations',0))");
      let finished = false;
      pending = migrate(contender, directory).then(() => { finished = true; });
      let waiting = false;
      for (let n = 0; n < 30; n++) {
        waiting = (await db.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND wait_event='advisory' AND pid<>pg_backend_pid() AND datname=current_database()")).rowCount! > 0;
        if (waiting) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(waiting).toBe(true);
      expect(finished).toBe(false);
      expect((await db.query('SELECT to_regclass($1) AS relation', [`${schema}.qa_lock_probe`])).rows).toEqual([{ relation: null }]);
      await holder.query("SELECT pg_advisory_unlock(hashtextextended('antseed:migrations',0))");
      await pending;
      expect((await contender.query('SELECT * FROM qa_lock_probe')).rows).toEqual([{ id: 1 }]);
      expect((await contender.query('SELECT count(*)::int AS n FROM schema_migrations')).rows).toEqual([{ n: 1 }]);
    } finally {
      await holder.query('SELECT pg_advisory_unlock_all()'); holder.release();
      await pending?.catch(() => {});
      await contender.close();
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves a human-moved recovered task, unrelated label and full task fields', async () => {
    const company = (await db.query("INSERT INTO companies(canonical_name) VALUES('Independent QA synthetic') RETURNING id")).rows[0]!['id'] as string;
    const chat = `-${parseInt(randomUUID().replaceAll('-', '').slice(0, 10), 16)}`;
    await db.query("INSERT INTO chats(id,kind,title,inclusion,mapping_status,company_id) VALUES($1,'group','Independent QA synthetic','included','confirmed',$2)", [chat, company]);
    const ticket = (await db.query('INSERT INTO tickets(chat_id,company_id) VALUES($1,$2) RETURNING id', [chat, company])).rows[0]!['id'] as string;
    const board = await adapter.ensureBoard();
    const input = { ticketId: ticket, title: 'Independent QA recovered task', description: 'Synthetic record; no real company.', workstream: 'Buyer' as const };
    const task = await adapter.ensureTask(input);
    const label = await api('/labels', 'POST', { title: `QA-unrelated-${ticket}` });
    try {
      await api(`/tasks/${task.id}/labels`, 'POST', { label_id: label['id'] });
      const raw = await api(`/tasks/${task.id}`);
      await api(`/tasks/${task.id}`, 'PUT', { ...raw, priority: 4, due_date: '2026-10-22T05:30:00Z', percent_done: 0.5 });
      // An explicit QA fixture action through the real upstream API, not product AI approval.
      await api(`/projects/${board.projectId}/views/${board.viewId}/buckets/${board.buckets.Completed}/tasks`, 'PUT', { task_id: Number(task.id) });
      const before = await api(`/tasks/${task.id}`);
      expect(before['done']).toBe(true); expect(before['priority']).toBe(4);
      await db.query('UPDATE tickets SET vikunja_task_id=NULL WHERE id=$1', [ticket]);
      const recovered = await adapter.ensureTask(input);
      expect(recovered.id).toBe(task.id); expect(recovered.bucketId).toBe(board.buckets.Completed);
      const after = await adapter.updateTaskDetails({ taskId: task.id, title: 'QA changed only details', description: 'Only descriptive fields changed.', workstream: 'Integration' });
      expect(after.bucketId).toBe(board.buckets.Completed);
      expect(after.description.match(new RegExp(`\\[antseed-ticket:${ticket}\\]`, 'g'))).toHaveLength(1);
      const final = await api(`/tasks/${task.id}`);
      for (const field of ['done', 'priority', 'due_date', 'percent_done']) expect(final[field], field).toEqual(before[field]);
      expect((final['labels'] as Array<{ title: string }>).map((l) => l.title).sort()).toEqual(['Integration', label['title']].sort());
      let matches = 0;
      for (let page = 1; ; page++) {
        const list = await api(`/projects/${board.projectId}/tasks?page=${page}&per_page=1`);
        expect(Object.keys(list)).toEqual(expect.arrayContaining(['items', 'total', 'page', 'per_page', 'total_pages']));
        matches += (list['items'] as Array<{ description: string }>).filter((t) => t.description.includes(`[antseed-ticket:${ticket}]`)).length;
        if (page >= Number(list['total_pages'])) break;
      }
      expect(matches).toBe(1);
    } finally { await api(`/labels/${label['id']}`, 'DELETE'); }
  });
});
