import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { API_OPERATIONS } from '../../src/shared/api.js';
import { loadRuntimeConfig } from '../../src/platform/config.js';
import { createPlatformModule } from '../../src/platform/module.js';

describe('platform onboarding construction before readiness', () => {
  it('registers canonical chat routes without SQL/native/network side effects; requests report unavailable', async () => {
    const config = await loadRuntimeConfig({ AI_ENV_PATH: '/nonexistent-antseed-m2.env', TELEGRAM_APPLICATION_PROFILE: 'custom', DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused' });
    const module = await createPlatformModule(config), query = vi.spyOn(module.services.db, 'query');
    const app = await buildApp({ modules: [{ ...module, start: async () => {} }] });
    try {
      await app.ready(); expect(query).not.toHaveBeenCalled();
      for (const op of API_OPERATIONS.filter((o) => o.path.startsWith('/api/chats'))) {
        const response = await app.inject({ method: op.method, url: op.path.replace(':chatId', '-10042'), ...(op.method !== 'GET' ? { payload: {} } : {}) });
        expect(response.statusCode).toBe(503); expect(response.json().error.code).toBe('upstream_unavailable');
      }
      expect(query).not.toHaveBeenCalled(); expect((await app.inject('/')).body).toContain('Configure control group');
      const login = await app.inject('/api/telegram/login'); expect(login.json().state).toBe('unconfigured');
      expect((await app.inject({ method: 'POST', url: '/api/telegram/login', payload: { step: 'code', code: 'synthetic-private-code' } })).body).not.toContain('synthetic-private-code');
    } finally { await app.close(); }
  });
});
