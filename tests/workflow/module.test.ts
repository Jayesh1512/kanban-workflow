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
