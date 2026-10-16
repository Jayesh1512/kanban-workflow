import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRuntimeConfig } from '../../src/platform/config.js';
import { telegramApplication } from '../../src/platform/telegram-profile.js';

describe('published Telegram application selection (configuration only; no account action)', () => {
  it('defaults to the published tdl pair without requiring app registration or APP_OWNER', async () => {
    const a = telegramApplication({}), b = telegramApplication({ TELEGRAM_APPLICATION_PROFILE: 'tdl' });
    expect(a).toEqual(b); expect(Number.isSafeInteger(a.apiId) && a.apiId! > 0).toBe(true); expect(/^[a-f0-9]{32}$/.test(a.apiHash!)).toBe(true);
    const config = await loadRuntimeConfig({ AI_ENV_PATH: '/nonexistent-profile.env' }); expect(config.telegram.apiId === a.apiId && config.telegram.apiHash === a.apiHash).toBe(true);
  });
  it.each(['tdl', 'custom'])('preserves complete custom overrides over profile %s without copying owner gates', (profile) => {
    expect(telegramApplication({ TELEGRAM_APPLICATION_PROFILE: profile, TELEGRAM_API_ID: '123', TELEGRAM_API_HASH: 'synthetic-custom' })).toEqual({ apiId: 123, apiHash: 'synthetic-custom' });
  });
  it('keeps an explicit empty custom profile unconfigured', () => { expect(telegramApplication({ TELEGRAM_APPLICATION_PROFILE: 'custom' })).toEqual({ apiId: null, apiHash: null }); });
  it.each([
    { TELEGRAM_APPLICATION_PROFILE: 'unknown-private-sentinel' }, { TELEGRAM_API_ID: '123' }, { TELEGRAM_API_HASH: 'private-half-sentinel' },
    { TELEGRAM_API_ID: 'invalid-private-id', TELEGRAM_API_HASH: 'synthetic' },
  ])('rejects unknown profiles/partial pairs/invalid ID without echoing values', (env) => {
    let error: unknown; try { telegramApplication(env); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(Error); expect(String(error)).not.toMatch(/unknown-private-sentinel|private-half-sentinel|invalid-private-id/);
  });
  it('loads profile/custom pairs from mounted configuration, blank Compose fields preserve them, nonblank overrides win', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'antseed-profile-')), file = join(dir, 'runtime.env');
    try {
      await writeFile(file, 'TELEGRAM_APPLICATION_PROFILE=custom\nTELEGRAM_API_ID=123\nTELEGRAM_API_HASH=synthetic-mounted\n');
      const config = await loadRuntimeConfig({ AI_ENV_PATH: '/nonexistent-profile.env', RUNTIME_ENV_PATH: file, TELEGRAM_APPLICATION_PROFILE: '', TELEGRAM_API_ID: '', TELEGRAM_API_HASH: '' });
      expect(config.telegram.apiId).toBe(123); expect(config.telegram.apiHash).toBe('synthetic-mounted');
      const overridden = await loadRuntimeConfig({ AI_ENV_PATH: '/nonexistent-profile.env', RUNTIME_ENV_PATH: file, TELEGRAM_APPLICATION_PROFILE: 'tdl', TELEGRAM_API_ID: '456', TELEGRAM_API_HASH: 'synthetic-env' });
      expect(overridden.telegram.apiId).toBe(456); expect(overridden.telegram.apiHash).toBe('synthetic-env');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
