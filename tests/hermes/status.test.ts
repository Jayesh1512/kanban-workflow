import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { createPlatformModule } from '../../src/platform/module.js';
import { loadRuntimeConfig } from '../../src/platform/config.js';
import { createWorkflowModule } from '../../src/workflow/module.js';

// Real A route registered first, then B hook. Synthetic DB failures; no sockets/providers.
describe('existing platform status route extension', () => {
  it.each([['42P01', 'database_pending', 'connecting'], ['08006', 'database_unavailable', 'unavailable']] as const)('preserves onboarding before/without database: %s', async (code, expectedCode, state) => {
    const config = await loadRuntimeConfig({ AI_ENV_PATH: '/antseed-test-no-ai', DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test' });
    const platform = await createPlatformModule(config); const db = vi.spyOn(platform.services.db, 'query').mockRejectedValue(Object.assign(new Error('PRIVATE DATABASE DETAIL'), { code }));
    const workflow = await createWorkflowModule(platform.services); const app = Fastify();
    try {
      await platform.register(app); const original = await platform.operationsStatus(); await workflow.register(app);
      const response = await app.inject('/api/status'); expect(response.statusCode).toBe(200);
      const payload = response.json(); expect(payload.components).toMatchObject({ database: { code: 'database_pending' }, telegram: { state: original.components['telegram']!.state }, workflow: { code: 'not_started' }, extraction: { state: 'unconfigured' }, jev: { state, code: expectedCode } });
      expect(payload).toMatchObject({ accountBound: false, imports: [], configuration: { aiEnvReadable: false, extractionConfigured: false, jevConfigured: false } });
      expect(response.body).not.toContain('PRIVATE'); expect((await app.inject('/')).statusCode).toBe(200);
      expect((await app.inject('/api/companies')).statusCode).toBe(503);
    } finally { await workflow.stop(); db.mockRestore(); await platform.stop(); await app.close(); }
  });
});
