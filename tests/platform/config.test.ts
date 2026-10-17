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
  it('uses the existing OpenAI key for native gpt-6-luna decisions without Gateway credentials', async () => {
    const config = await loadRuntimeConfig({ AI_ENV_PATH: '/missing', MOVEMENT_PROVIDER: 'openai', JEV_ENDPOINT: '', JEV_MODEL: '', OPENAI_API_KEY: 'synthetic-openai', AI_GATEWAY_API_KEY: 'synthetic-old-gateway' });
    expect(config.jev).toMatchObject({ provider: 'openai', model: 'gpt-6-luna', endpoint: 'https://api.openai.com/v1/decisions', apiKey: 'synthetic-openai' });
    expect(config.extraction.provider).toBe('openai');
    expect((await loadRuntimeConfig({ AI_ENV_PATH: '/missing', MOVEMENT_PROVIDER: 'openai', AI_GATEWAY_API_KEY: 'synthetic-old-gateway' })).jev.apiKey).toBeNull();
  });
  it.each([{ JEV_MODEL: 'gpt-6.1-sol' }, { JEV_ENDPOINT: 'https://openrouter.ai/api/v1/systemone' }])('rejects unsupported native decision configuration: %j', async input => {
    await expect(loadRuntimeConfig({ AI_ENV_PATH: '/missing', MOVEMENT_PROVIDER: 'openai', ...input })).rejects.toThrow();
  });
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
  it('preserves mounted Telegram credentials when optional Compose fields are blank', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'antseed-telegram-config-')); directories.push(dir); const file = join(dir, 'ai.env');
    await writeFile(file, 'TELEGRAM_API_ID=123\nTELEGRAM_API_HASH=synthetic-mounted-hash\n');
    const config = await loadRuntimeConfig({ AI_ENV_PATH: file, TELEGRAM_API_ID: '', TELEGRAM_API_HASH: ' ' });
    expect(config.telegram.apiId).toBe(123); expect(config.telegram.apiHash).toBe('synthetic-mounted-hash');
    const override = await loadRuntimeConfig({ AI_ENV_PATH: file, TELEGRAM_API_ID: '456', TELEGRAM_API_HASH: 'synthetic-override' });
    expect(override.telegram.apiId).toBe(456); expect(override.telegram.apiHash).toBe('synthetic-override');
  });
  it('allows per-deployment extraction limits without blank Compose fields erasing mounted settings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'antseed-extraction-config-')); directories.push(dir); const file = join(dir, 'ai.env');
    await writeFile(file, 'OPENAI_TIMEOUT_MS=30000\nOPENAI_MAX_OUTPUT_TOKENS=4096\n');
    const mounted = await loadRuntimeConfig({ AI_ENV_PATH: file, OPENAI_TIMEOUT_MS: '', OPENAI_MAX_OUTPUT_TOKENS: ' ' });
    expect(mounted.extraction).toMatchObject({ timeoutMs: 30000, maxOutputTokens: 4096 });
    const override = await loadRuntimeConfig({ AI_ENV_PATH: file, OPENAI_TIMEOUT_MS: '90000', OPENAI_MAX_OUTPUT_TOKENS: '8192' });
    expect(override.extraction).toMatchObject({ timeoutMs: 90000, maxOutputTokens: 8192, model: mounted.extraction.model });
  });
  it('keeps onboarding reachable when configuration or database is unavailable', async () => {
    const config = await loadRuntimeConfig({ AI_ENV_PATH: '/missing/ai.env', DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/none' });
    expect(configMetadata(config).aiEnvReadable).toBe(false);
    const module = await createPlatformModule(config), app = await buildApp({ modules: [module] });
    expect((await app.inject('/')).statusCode).toBe(200);
    const status = (await app.inject('/api/status')).json();
    expect(status.configuration.aiEnvReadable).toBe(false);
    expect(status.components.telegram.code).toBe('login_required');
    expect((await app.inject('/health/ready')).statusCode).toBe(503);
    const login = await app.inject({ method: 'POST', url: '/api/telegram/login', payload: { step: 'phone', phone: '+1000000000' } });
    expect(login.statusCode).toBe(503); expect(login.json().error.code).toBe('upstream_unavailable');
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
