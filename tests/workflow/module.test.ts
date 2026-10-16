import Fastify from 'fastify';
import { expect, it } from 'vitest';
import type { PlatformServices } from '../../src/shared/ports.js';
import { loadRuntimeConfig } from '../../src/platform/config.js';
import { createWorkflowModule } from '../../src/workflow/module.js';

it('constructs/registers/starts/stops without touching platform DB, upstreams or starting loops', async () => {
  const unavailable = new Proxy({}, { get() { throw new Error('M3.1 lifecycle must not access upstream/platform resources'); } });
  const config = await loadRuntimeConfig({ AI_ENV_PATH: '/tmp/antseed-nonexistent-config-for-module-test' });
  const platform = { config, clock: { now: () => new Date('2026-10-17T00:00:00Z') }, db: unavailable, telegram: unavailable, vikunja: unavailable, chats: unavailable, control: unavailable, ingestion: unavailable } as PlatformServices;
  const module = await createWorkflowModule(platform); const app = Fastify();
  await module.stop(); await module.register(app); await module.start(); expect(await module.status()).toMatchObject({ state: 'degraded', code: 'm31_manual_dispatch' });
  await module.stop(); await module.stop(); await app.close();
});
