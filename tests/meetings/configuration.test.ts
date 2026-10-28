import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { loadRuntimeConfig } from '../../src/platform/config.js';

it('keeps mounted Fathom credentials and options when Compose injects blank optional fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-config-'));
  try {
    const file = join(directory, 'runtime.env');
    await writeFile(file, 'FATHOM_ENABLED=true\nFATHOM_API_KEY=synthetic-private-key\nFATHOM_WEBHOOK_SECRET=synthetic-secret\nMEETINGS_VIKUNJA_PROJECT_ID=7\nMEETINGS_INTERNAL_DOMAINS=example.org,internal.example\n');
    const config = await loadRuntimeConfig({ AI_ENV_PATH: '/missing', RUNTIME_ENV_PATH: file, FATHOM_ENABLED: '', FATHOM_API_KEY: ' ', FATHOM_WEBHOOK_SECRET: '', MEETINGS_VIKUNJA_PROJECT_ID: '', MEETINGS_INTERNAL_DOMAINS: '' });
    expect(config.meetings).toMatchObject({ enabled: true, apiKey: 'synthetic-private-key', webhookSecret: 'synthetic-secret', projectId: '7', internalDomains: ['example.org', 'internal.example'] });
    const override = await loadRuntimeConfig({ AI_ENV_PATH: '/missing', RUNTIME_ENV_PATH: file, FATHOM_ENABLED: 'false', MEETINGS_VIKUNJA_PROJECT_ID: '9' });
    expect(override.meetings).toMatchObject({ enabled: false, projectId: '9' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('keeps the existing app usable without Fathom and rejects malformed connection controls', async () => {
  expect((await loadRuntimeConfig({ AI_ENV_PATH: '/missing' })).meetings).toMatchObject({ enabled: false, apiKey: null });
  for (const input of [{ FATHOM_ENABLED: 'yes' }, { FATHOM_TIMEOUT_MS: '-1' }, { MEETINGS_VIKUNJA_PROJECT_ID: 'wrong' }]) {
    await expect(loadRuntimeConfig({ AI_ENV_PATH: '/missing', ...input })).rejects.toThrow();
  }
});
