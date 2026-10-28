import { readFile } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { DomainError, MCP_OPERATIONS } from '../../src/shared/api.js';
import type { DomainServices } from '../../src/shared/ports.js';
import { loadRuntimeConfig } from '../../src/platform/config.js';
import { createBindings } from '../../src/hermes/bindings.js';
import { registerHttp } from '../../src/hermes/http.js';
import { createMeetingFeature } from '../../src/meetings/feature.js';
import { fixtureDatabase } from '../workflow/database.js';

const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const work of close.splice(0).reverse()) await work(); });
async function setup() {
  const db = await fixtureDatabase(['003_meetings', '004_meeting_ingestion', '005_meeting_tasks'].map(name => new URL('../../db/migrations/202610260' + name + '.sql', import.meta.url)));
  close.push(() => db.close());
  const config = await loadRuntimeConfig({ AI_ENV_PATH: '/missing', FATHOM_ENABLED: 'false', FATHOM_API_KEY: 'synthetic-private-key' });
  const feature = createMeetingFeature({ db, config, clock: { now: () => new Date() } }, { taskPort: null });
  let ready = true;
  const gate = async () => { if (!ready) throw new DomainError('upstream_unavailable', 'Database initialization pending', true); };
  const app = await buildApp({ modules: [{ name: 'meeting-feature-test', async register(server) {
    await feature.register(server, gate);
    registerHttp(server, createBindings({ meetings: feature.archive } as unknown as DomainServices, 'http'), gate, work => work(), MCP_OPERATIONS.filter(operation => operation.service.startsWith('meetings.')));
  }, async start() {}, async stop() {}, async status() { return { state: 'ready', code: null, detail: null, checkedAt: new Date().toISOString() }; } }] });
  close.push(() => app.close());
  return { db, feature, app, readiness(value: boolean) { ready = value; } };
}

it('keeps the meeting page available during readiness failure and does not leak server credentials', async () => {
  const h = await setup(); h.readiness(false);
  expect((await h.app.inject('/meetings')).statusCode).toBe(200);
  expect((await h.app.inject('/api/meetings')).statusCode).toBe(503);
  expect((await h.app.inject('/api/meetings/status')).statusCode).toBe(503);
  expect((await h.app.inject({ method: 'POST', url: '/api/integrations/fathom/webhook', payload: '{}' })).statusCode).toBe(503);
  h.readiness(true);
  const status = await h.app.inject('/api/meetings/status');
  expect(status.statusCode).toBe(200); expect(status.body).not.toContain('synthetic-private-key');
  await h.feature.tick(); // Disabled Fathom and null task sink perform no external work.
});

it('imports operator Fathom JSON through the normal parser, queues tasks automatically, and keeps oversize failures at 413', async () => {
  const h = await setup();
  const meeting = JSON.parse(await readFile(new URL('./fixtures/fathom-meeting.json', import.meta.url), 'utf8'));
  const imported = await h.app.inject({ method: 'POST', url: '/api/meetings/import', payload: { meetings: [meeting] } });
  expect(imported.statusCode, imported.body).toBe(200);
  expect(imported.json().imported).toBe(1);
  expect((await h.db.query("SELECT count(*)::int AS count FROM meeting_task_exports WHERE state='queued'")).rows[0]!.count).toBe(2);
  const listed = await h.app.inject('/api/meetings?limit=1'); expect(listed.json().total).toBe(1);
  expect((await h.app.inject('/api/meetings/' + listed.json().items[0].id + '/transcript?limit=2&revision=1')).json().items).toHaveLength(2);
  expect((await h.app.inject({ method: 'POST', url: '/api/meetings/import', payload: { meetings: [] } })).statusCode).toBe(400);
  const oversized = ' '.repeat(20 * 1024 * 1024 + 1);
  expect((await h.app.inject({ method: 'POST', url: '/api/meetings/import', headers: { 'content-type': 'application/json' }, payload: oversized })).statusCode).toBe(413);
  expect((await h.app.inject({ method: 'POST', url: '/api/integrations/fathom/webhook', headers: { 'content-type': 'application/json' }, payload: oversized })).statusCode).toBe(413);
});
