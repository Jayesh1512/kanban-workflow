import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configMetadata, loadRuntimeConfig } from '../../src/platform/config.js';
import { createPlatformModule } from '../../src/platform/module.js';
import { buildApp } from '../../src/app.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
describe('runtime configuration and M1 status', () => {
  it('parses runtime files without executing them; env overrides; blank Jev key uses Gateway', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'antseed-config-')); directories.push(dir);
    const file = join(dir, 'ai.env'), runtime = join(dir, 'runtime.env');
    const sentinel = 'sentinel-secret-do-not-render';
    await writeFile(file, `OPENAI_API_KEY=${sentinel}\nOPENAI_MODEL=file-model\nJEV_API_KEY=\nAI_GATEWAY_API_KEY=${sentinel}\nOPENAI_TIMEOUT_MS=1234\nUNUSED=$(touch ${join(dir, 'never')})\n`);
    await writeFile(runtime, 'DATABASE_URL=postgresql://user:private@127.0.0.1:1/example\nVIKUNJA_PASSWORD=private\n');
    const config = await loadRuntimeConfig({ AI_ENV_PATH: file, RUNTIME_ENV_PATH: runtime, OPENAI_MODEL: 'env-model' });
    expect(config.extraction.model).toBe('env-model'); expect(config.extraction.apiKey).toBe(sentinel);
    expect(config.extraction.timeoutMs).toBe(1234); expect(config.jev.apiKey).toBe(sentinel);
    expect(config.jev.provider).toBe('vercel'); expect(config.vikunja.password).toBe('private');
    expect(configMetadata(config).aiEnvReadable).toBe(true);
    const module = await createPlatformModule(config), app = await buildApp({ modules: [module] });
    const result = await app.inject('/api/status');
    expect(result.body).not.toContain(sentinel); expect(result.body).not.toContain('postgresql://');
    expect(result.json().components.jev.state).toBe('degraded');
    expect(result.json().components.jev.code).toBe('not_checked');
    await app.close();
  });
  it('keeps onboarding reachable when configuration or database is unavailable', async () => {
    const config = await loadRuntimeConfig({ AI_ENV_PATH: '/missing/ai.env', DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/none' });
    expect(configMetadata(config).aiEnvReadable).toBe(false);
    const module = await createPlatformModule(config), app = await buildApp({ modules: [module] });
    expect((await app.inject('/')).statusCode).toBe(200);
    const status = (await app.inject('/api/status')).json();
    expect(status.configuration.aiEnvReadable).toBe(false);
    expect(status.components.telegram.code).toBe('telegram_m2_pending');
    expect((await app.inject('/health/ready')).statusCode).toBe(503);
    const login = await app.inject({ method: 'POST', url: '/api/telegram/login', payload: { step: 'phone', phone: '+1000000000' } });
    expect(login.statusCode).toBe(503); expect(login.json().error.code).toBe('not_configured');
    expect((await app.inject({ method: 'POST', url: '/api/telegram/login', payload: { step: 'code', code: '' } })).statusCode).toBe(400);
    await app.close(); await module.stop();
  });
  it.each([
    { JEV_ENDPOINT: 'https://direct.example/v1/systemone' }, { PORT: '3000oops' },
    { OPENAI_TIMEOUT_MS: '-1' }, { TELEGRAM_HISTORY_BATCH_SIZE: '101' }, { TIMEZONE: 'Mars/Unknown' },
  ])('rejects invalid configuration without exposing its value: %j', async (input) => {
    await expect(loadRuntimeConfig({ AI_ENV_PATH: '/missing', ...input })).rejects.toThrow();
  });
});
