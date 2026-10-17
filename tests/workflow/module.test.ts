import Fastify from 'fastify';
import { afterEach, expect, it } from 'vitest';
import type { PlatformServices } from '../../src/shared/ports.js';
import { loadRuntimeConfig } from '../../src/platform/config.js';
import { createWorkflowModule } from '../../src/workflow/module.js';
import { workflowHarness } from './harness.js';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((close) => close())); });
it('registers its durable control subscriber before start and waits for the platform migration ledger', async () => {
  const h = await workflowHarness(); cleanups.push(() => h.db.close());
  const config = await loadRuntimeConfig({ AI_ENV_PATH: '/tmp/antseed-nonexistent-config-for-module-test' });
  const unavailable = new Proxy({}, { get() { throw new Error('Unrelated platform service must not be accessed'); } });
  const platform = { config, clock: h.clock, db: h.db, vikunja: h.vikunja, control: h.control, telegram: unavailable, chats: unavailable, ingestion: unavailable } as PlatformServices;
  const module = await createWorkflowModule(platform); const app = Fastify(); cleanups.push(() => app.close());
  await module.register(app); expect(h.handlers.size).toBe(1); expect((await module.status()).code).toBe('not_started');
  await module.start();
  // Stop waits for the in-flight readiness check. An absent ledger never starts domain work.
  await module.stop(); expect(h.handlers.size).toBe(0); expect(h.moves()).toBe(0); expect(h.tasks.size).toBe(0);
  await module.stop(); await module.start(); expect(h.handlers.size).toBe(0);
});
it('stop before register/start is safe and never installs a subscriber', async () => {
  const h = await workflowHarness(); cleanups.push(() => h.db.close());
  const config = await loadRuntimeConfig({ AI_ENV_PATH: '/tmp/antseed-nonexistent-config-for-module-test' });
  const platform = { config, clock: h.clock, db: h.db, vikunja: h.vikunja, control: h.control } as PlatformServices;
  const module = await createWorkflowModule(platform); const app = Fastify(); cleanups.push(() => app.close());
  await module.stop(); await module.register(app); await module.start(); await module.stop(); expect(h.handlers.size).toBe(0);
});

it('refuses a complete version ledger with wrong checksums before any domain side effect', async () => {
  const h = await workflowHarness(); cleanups.push(() => h.db.close()); const { readdir } = await import('node:fs/promises');
  await h.db.query('CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum text NOT NULL)');
  for (const name of (await readdir(new URL('../../db/migrations/', import.meta.url))).filter((name) => /^\d[\w.-]*\.sql$/.test(name))) await h.db.query('INSERT INTO schema_migrations VALUES($1,$2)', [name, 'deliberately-wrong-checksum']);
  const config = await loadRuntimeConfig({ AI_ENV_PATH: '/tmp/antseed-nonexistent-config-for-module-test', AI_GATEWAY_API_KEY: 'synthetic-not-a-real-key' });
  const platform = { config, clock: h.clock, db: h.db, vikunja: h.vikunja, control: h.control } as PlatformServices; const module = await createWorkflowModule(platform);
  const priorWorkflowState = (await h.db.query("SELECT * FROM app_settings WHERE key LIKE 'workflow:%' ORDER BY key")).rows;
  await module.start(); const { setTimeout: delay } = await import('node:timers/promises');
  for (let i = 0; i < 100 && (await module.status()).code === 'not_started'; i++) await delay(10);
  await module.stop(); expect(await module.status()).toMatchObject({ state: 'unavailable', code: 'migration_drift' });
  expect(h.tasks.size).toBe(0); expect((await h.db.query("SELECT * FROM app_settings WHERE key LIKE 'workflow:%' ORDER BY key")).rows).toEqual(priorWorkflowState);
});
