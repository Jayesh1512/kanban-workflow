import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { PgDatabase } from '../../src/platform/database.js';
import { loadRuntimeConfig } from '../../src/platform/config.js';
import { createPlatformModule } from '../../src/platform/module.js';
import type { PlatformModule } from '../../src/shared/ports.js';

const url = process.env['PLATFORM_GATE_TEST_DATABASE_URL'];
describe.skipIf(!url)('platform HTTP migration gate against isolated actual PostgreSQL', () => {
  let admin: PgDatabase, platform: PlatformModule, app: Awaited<ReturnType<typeof buildApp>>, schema: string;
  let ledger: Array<{ version: string; checksum: string }>;
  beforeEach(async () => {
    admin = new PgDatabase(url!); schema = `platform_gate_${randomUUID().replaceAll('-', '')}`; await poll(async () => { try { await admin.query('SELECT 1'); return true; } catch { return false; } }); await admin.query(`CREATE SCHEMA ${schema}`);
    const uri = new URL(url!); uri.searchParams.set('options', `-c search_path=${schema},public`);
    const config = await loadRuntimeConfig({ AI_ENV_PATH: '/nonexistent-gate.env', TELEGRAM_APPLICATION_PROFILE: 'custom', DATABASE_URL: uri.toString(), VIKUNJA_URL: 'http://127.0.0.1:1' });
    platform = await createPlatformModule(config); app = await buildApp({ modules: [platform] }); await app.ready();
    await poll(async () => (await platform.operationsStatus()).components['database']?.state === 'ready');
    await platform.services.ingestion.bindAccount('123'); await platform.services.ingestion.upsertDialog({ id: '-10042', kind: 'supergroup', title: 'Synthetic gate fixture', username: null, archived: false });
    ledger = (await platform.services.db.query<{ version: string; checksum: string }>('SELECT version,checksum FROM schema_migrations ORDER BY version')).rows;
    expect((await app.inject('/api/chats')).statusCode).toBe(200);
  });
  afterEach(async () => { await app?.close(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.close(); });
  async function poll(check: () => Promise<boolean>) {
    const deadline = Date.now() + 10_000;
    while (!await check()) { if (Date.now() > deadline) throw new Error('Gate fixture did not initialize'); await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  async function snapshot() {
    const db = platform.services.db;
    return { chats: (await db.query('SELECT id,inclusion,policy_version,mapping_status,mapping_version FROM chats ORDER BY id')).rows,
      history: (await db.query('SELECT * FROM history_cursors ORDER BY chat_id')).rows, requests: (await db.query('SELECT * FROM telegram_history_requests ORDER BY chat_id')).rows,
      commands: (await db.query('SELECT * FROM idempotency_keys ORDER BY key')).rows, mappings: (await db.query('SELECT * FROM mapping_history ORDER BY id')).rows,
      setups: (await db.query('SELECT * FROM control_setup_operations ORDER BY operation_key')).rows };
  }
  async function blocked() {
    const cases = [
      { method: 'GET' as const, url: '/api/chats' }, { method: 'PUT' as const, url: '/api/chats/-10042/inclusion', payload: { idempotencyKey: 'blocked-inclusion', inclusion: 'excluded', expectedPolicyVersion: 0 } },
      { method: 'GET' as const, url: '/api/chats/-10042/import' }, { method: 'POST' as const, url: '/api/chats/-10042/import', payload: { idempotencyKey: 'blocked-import', maxBatches: 1, batchSize: 1 } },
      { method: 'GET' as const, url: '/api/chats/-10042/mapping' }, { method: 'PUT' as const, url: '/api/chats/-10042/mapping', payload: { idempotencyKey: 'blocked-mapping', expectedMappingVersion: 0, companyId: null, status: 'non_company', evidenceIds: [], reason: 'Synthetic gate check' } },
      { method: 'POST' as const, url: '/api/telegram/login', payload: { step: 'phone', phone: '+1000000000' } },
      { method: 'POST' as const, url: '/api/telegram/control-setup', payload: { operationKey: 'blocked-setup', chatId: '-10042' } },
      { method: 'POST' as const, url: '/api/telegram/control-setup/blocked-setup/reconcile', payload: {} },
    ];
    const before = await snapshot(), beforeLedger = (await platform.services.db.query('SELECT * FROM schema_migrations ORDER BY version')).rows;
    for (const input of cases) { const response = await app.inject(input); expect(response.statusCode, `${input.method} ${input.url}`).toBe(503); expect(response.json().error.code).toBe('upstream_unavailable'); expect(response.body).not.toContain('+1000000000'); }
    expect(await snapshot()).toEqual(before); expect((await platform.services.db.query('SELECT * FROM schema_migrations ORDER BY version')).rows).toEqual(beforeLedger);
    for (const path of ['/', '/health/live', '/api/status', '/api/telegram/login']) expect((await app.inject(path)).statusCode).toBe(200);
  }
  it('rejects checksum drift after healthy startup without policy/import/mapping or ledger writes, including after initializer reruns', async () => {
    await platform.services.db.query("UPDATE schema_migrations SET checksum=repeat('0',64)"); await blocked();
    await new Promise((resolve) => setTimeout(resolve, 5_100));
    expect((await app.inject('/api/status')).json().components.database.code).toBe('migration_drift'); await blocked();
    for (const row of ledger) await platform.services.db.query('UPDATE schema_migrations SET checksum=$2 WHERE version=$1', [row.version, row.checksum]);
    const response = await app.inject({ method: 'PUT', url: '/api/chats/-10042/inclusion', payload: { idempotencyKey: 'healthy-recovery', inclusion: 'excluded', expectedPolicyVersion: 0 } });
    expect(response.statusCode).toBe(200); expect(response.json().inclusion).toBe('excluded');
  });
  it.each(['missing', 'unknown'] as const)('rejects %s migration rows without request-triggered repairs', async (kind) => {
    if (kind === 'missing') await platform.services.db.query('DELETE FROM schema_migrations WHERE version=$1', [ledger[0]!.version]);
    else await platform.services.db.query("INSERT INTO schema_migrations(version,checksum) VALUES('999_unknown.sql',repeat('f',64))");
    await blocked();
  });
  it('rejects absent ledger without recreating it from a request', async () => {
    await platform.services.db.query('DROP TABLE schema_migrations');
    const response = await app.inject({ method: 'PUT', url: '/api/chats/-10042/inclusion', payload: { idempotencyKey: 'absent-ledger', inclusion: 'excluded', expectedPolicyVersion: 0 } });
    expect(response.statusCode).toBe(503); expect(response.json().error.code).toBe('upstream_unavailable');
    expect((await platform.services.db.query('SELECT to_regclass($1) AS name',[schema+'.schema_migrations'])).rows[0]!['name']).toBeNull(); expect((await platform.services.chats.list({})).items[0]!.inclusion).toBe('included');
  });
  it('returns pending while another session owns the migration lock', async () => {
    await admin.withSessionLock('antseed:migrations', async () => { await blocked(); });
    expect((await app.inject('/api/chats')).statusCode).toBe(200);
  });
  it('sanitizes an actual database outage while keeping onboarding/live/status reachable, then recovers', async () => {
    const container = process.env['PLATFORM_GATE_TEST_CONTAINER']; if (!container || !/^antseed-(?:a-gate-[a-z0-9-]+|qa-m1-system-[a-z0-9-]+-postgres-1)$/.test(container)) throw new Error('Require an explicitly owned gate/system PostgreSQL container');
    if(container.startsWith('antseed-qa-m1-system-')){
      const project=execFileSync('docker',['inspect','--format','{{index .Config.Labels "com.docker.compose.project"}}',container],{encoding:'utf8'}).trim();
      expect(project+'-postgres-1').toBe(container);
    }
    const before = await snapshot(); execFileSync('docker', ['stop', container], { stdio: 'ignore' });
    try {
      const response = await app.inject({ method: 'PUT', url: '/api/chats/-10042/inclusion', payload: { idempotencyKey: 'db-outage', inclusion: 'excluded', expectedPolicyVersion: 0 } });
      expect(response.statusCode).toBe(503); expect(response.json().error.code).toBe('upstream_unavailable'); expect(response.body).not.toMatch(/postgresql|password|ECONNREFUSED/);
      for (const path of ['/', '/health/live', '/api/status', '/api/telegram/login']) expect((await app.inject(path)).statusCode).toBe(200);
    } finally { execFileSync('docker', ['start', container], { stdio: 'ignore' }); await poll(async () => { try { await admin.query('SELECT 1'); return true; } catch { return false; } }); }
    expect(await snapshot()).toEqual(before); expect((await app.inject('/api/chats')).statusCode).toBe(200);
  }, 30_000);
});
