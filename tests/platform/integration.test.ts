import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDatabase, migrate, defaultMigrationDirectory } from '../../src/platform/database.js';
import { loadRuntimeConfig } from '../../src/platform/config.js';
import { VikunjaAdapter } from '../../src/vikunja/adapter.js';
import type { RuntimeConfig } from '../../src/shared/ports.js';
import { LANES, WORKSTREAMS } from '../../src/shared/domain.js';

// Explicit opt-in; ordinary npm test does not touch Docker or existing upstream services.
const project = process.env['PLATFORM_TEST_PROJECT'];
describe.skipIf(!project)('real PostgreSQL and pinned Vikunja M1 integration', () => {
  let db: PgDatabase, config: RuntimeConfig, adapter: VikunjaAdapter;
  const compose = (...args: string[]) => execFileSync('docker', ['compose', '-p', project!, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  beforeAll(async () => {
    // Captured only in test memory, never printed or written to reports.
    const bundle = parse(compose('exec', '-T', 'backend', 'cat', '/run/antseed/runtime.env'));
    config = await loadRuntimeConfig({ ...bundle, AI_ENV_PATH: '/not-present', DATABASE_URL: bundle['DATABASE_URL']!.replace('postgres:5432', `127.0.0.1:${process.env['PLATFORM_TEST_PG_PORT'] ?? '18432'}`), VIKUNJA_URL: process.env['PLATFORM_TEST_VIKUNJA_URL'] ?? 'http://127.0.0.1:18381' });
    db = new PgDatabase(config.databaseUrl); adapter = new VikunjaAdapter(config.vikunja, db);
  });
  afterAll(async () => { await db?.close(); });
  it('uses separate databases, applies platform migrations and retains exact seeds', async () => {
    await migrate(db);
    expect((await db.query('SELECT name FROM lane_definitions ORDER BY position')).rows.map((r) => r['name'])).toEqual([...LANES]);
    expect((await db.query('SELECT name FROM workstream_definitions ORDER BY name')).rows.map((r) => r['name'])).toEqual([...WORKSTREAMS].sort());
    expect((await db.query('SELECT datname FROM pg_database WHERE datname IN ($1,$2)', ['antseed', 'vikunja'])).rowCount).toBe(2);
    expect((await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r['version'])).toEqual(['001_initial.sql', '202610170001_telegram_operations.sql', '202610170002_decision_origins.sql']);
  });
  it('rolls transactions back on one checked-out connection', async () => {
    const key = `test-${randomUUID()}`;
    await expect(db.transaction(async (tx) => {
      const a = (await tx.query('SELECT pg_backend_pid() AS pid')).rows[0]?.['pid'];
      await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2)', [key, '{}']);
      expect((await tx.query('SELECT pg_backend_pid() AS pid')).rows[0]?.['pid']).toBe(a);
      throw new Error('injected rollback');
    })).rejects.toThrow('injected rollback');
    expect((await db.query('SELECT * FROM app_settings WHERE key=$1', [key])).rowCount).toBe(0);
  });
  it('serializes concurrent migrations, rejects drift and rolls back failed DDL plus ledger', async () => {
    const schema = `m1_${randomUUID().replaceAll('-', '')}`, dir = await mkdtemp(join(tmpdir(), 'antseed-migrate-'));
    await db.query(`CREATE SCHEMA ${schema}`);
    const uri = new URL(config.databaseUrl); uri.searchParams.set('options', `-csearch_path=${schema}`);
    const isolated = new PgDatabase(uri.toString()), second = new PgDatabase(uri.toString());
    try {
      await writeFile(join(dir, '001_probe.sql'), 'CREATE TABLE probe (id integer PRIMARY KEY); INSERT INTO probe VALUES(1);');
      await Promise.all([migrate(isolated, dir), migrate(second, dir)]);
      expect((await isolated.query('SELECT * FROM probe')).rowCount).toBe(1);
      expect((await isolated.query('SELECT * FROM schema_migrations')).rowCount).toBe(1);
      await writeFile(join(dir, '002_failure.sql'), 'CREATE TABLE must_rollback(id integer); SELECT absent_column FROM probe;');
      await expect(migrate(isolated, dir)).rejects.toThrow();
      expect((await isolated.query("SELECT to_regclass('must_rollback') AS name")).rows[0]?.['name']).toBeNull();
      expect((await isolated.query('SELECT * FROM schema_migrations')).rowCount).toBe(1);
      await rm(join(dir, '002_failure.sql'));
      await writeFile(join(dir, '001_probe.sql'), 'CREATE TABLE drifted (id integer);');
      await expect(migrate(isolated, dir)).rejects.toThrow('checksum mismatch');
      expect((await isolated.query("SELECT to_regclass('drifted') AS name")).rows[0]?.['name']).toBeNull();
      expect((await readFile(join(defaultMigrationDirectory, '001_initial.sql'), 'utf8')).length).toBeGreaterThan(1_000);
    } finally { await isolated.close(); await second.close(); await db.query(`DROP SCHEMA ${schema} CASCADE`); await rm(dir, { recursive: true, force: true }); }
  });
  it('reconciles real default buckets, labels and managed view settings repeatedly without duplication', async () => {
    const first = await adapter.ensureBoard(), second = await adapter.ensureBoard();
    expect(second).toEqual(first);
    // Remote objects survived but local bootstrap binding writes were interrupted.
    await db.transaction(async (tx) => {
      await tx.query('DELETE FROM board_bindings');
      await tx.query('DELETE FROM board_buckets');
      await tx.query('DELETE FROM board_labels');
    });
    expect(await adapter.ensureBoard()).toEqual(first);
    const login = await fetch(`${config.vikunja.baseUrl}/api/v2/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: config.vikunja.username, password: config.vikunja.password }) });
    const { token } = await login.json() as { token: string };
    const read = async (path: string) => {
      const r = await fetch(`${config.vikunja.baseUrl}/api/v2${path}`, { headers: { Authorization: `Bearer ${token}` } });
      expect(r.status).toBe(200); return r.json();
    };
    const buckets = await read(`/projects/${first.projectId}/views/${first.viewId}/buckets`) as { items: { title: string; position: number }[] };
    expect(buckets.items.map((b) => b.title)).toEqual([...LANES]);
    expect(buckets.items.map((b) => b.position)).toEqual([100, 200, 300, 400, 500, 600]);
    const labels = await read('/labels') as { items: { title: string }[] };
    expect(labels.items.map((l) => l.title).sort()).toEqual([...WORKSTREAMS].sort());
    const view = await read(`/projects/${first.projectId}/views/${first.viewId}`) as { default_bucket_id: number; done_bucket_id: number; filter: unknown };
    expect(String(view.default_bucket_id)).toBe(first.buckets['To be started']); expect(String(view.done_bucket_id)).toBe(first.buckets.Completed); expect(view.filter).toBeNull();
  });
  it('recovers marker-based creates; verifies bucket/done/labels and detail updates preserve lane', async () => {
    const company = (await db.query("INSERT INTO companies(canonical_name) VALUES('M1 synthetic company') RETURNING id")).rows[0]?.['id'] as string;
    const chatId = String(-parseInt(randomUUID().replaceAll('-', '').slice(0, 10), 16));
    await db.query("INSERT INTO chats(id,kind,title,inclusion,mapping_status,company_id) VALUES($1,'group','M1 synthetic fixture','included','confirmed',$2) ON CONFLICT(id) DO NOTHING", [chatId, company]);
    const ticket = (await db.query('INSERT INTO tickets(chat_id,company_id) VALUES($1,$2) ON CONFLICT(chat_id) DO UPDATE SET company_id=$2 RETURNING id', [chatId, company])).rows[0]?.['id'] as string;
    const board = await adapter.ensureBoard();
    const auth = await fetch(`${config.vikunja.baseUrl}/api/v2/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: config.vikunja.username, password: config.vikunja.password }) }).then((r) => r.json()) as { token: string };
    const rawTask = async (taskId: string) => fetch(`${config.vikunja.baseUrl}/api/v2/tasks/${taskId}`, { headers: { Authorization: `Bearer ${auth.token}` } }).then((r) => r.json()) as Promise<{ done: boolean; labels: { title: string }[] }>;
    const input = { ticketId: ticket, title: 'M1 synthetic ticket', description: 'Isolated integration only', workstream: 'Buyer' as const };
    const first = await adapter.ensureTask(input); expect(first.bucketId).toBe(board.buckets['To be started']);
    expect((await adapter.ensureTask(input)).id).toBe(first.id);
    // Simulate remote accepted but local projection ID not committed.
    await db.query('UPDATE tickets SET vikunja_task_id=NULL WHERE id=$1', [ticket]);
    expect((await adapter.ensureTask(input)).id).toBe(first.id);
    await adapter.moveTask({ taskId: first.id, projectId: board.projectId, viewId: board.viewId, targetBucketId: board.buckets.Completed });
    expect((await rawTask(first.id)).done).toBe(true);
    await adapter.moveTask({ taskId: first.id, projectId: board.projectId, viewId: board.viewId, targetBucketId: board.buckets.Completed });
    const details = await adapter.updateTaskDetails({ taskId: first.id, title: 'Updated synthetic title', description: 'Updated only', workstream: 'Integration' });
    expect(details.bucketId).toBe(board.buckets.Completed); expect(details.description).toContain(`[antseed-ticket:${ticket}]`);
    expect((await rawTask(first.id)).done).toBe(true);
    expect((await rawTask(first.id)).labels.map((l) => l.title)).toEqual(['Integration']);
    await adapter.moveTask({ taskId: first.id, projectId: board.projectId, viewId: board.viewId, targetBucketId: board.buckets.Archived });
    expect((await adapter.getTask(first.id))?.bucketId).toBe(board.buckets.Archived);
    expect((await rawTask(first.id)).done).toBe(false);
    await expect(adapter.moveTask({ taskId: first.id, projectId: '999999', viewId: board.viewId, targetBucketId: board.buckets.Completed })).rejects.toThrow('outside the managed board');
  });
});
