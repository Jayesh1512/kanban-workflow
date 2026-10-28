import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import { API_OPERATIONS, MCP_OPERATIONS } from '../../src/shared/api.js';
import { loadRuntimeConfig } from '../../src/platform/config.js';

it('initializes Telegram/CRM/Work while retaining dormant historical Meeting migrations', async () => {
  const db = new PGlite();
  try {
    const directory = new URL('../../db/migrations/', import.meta.url);
    const files = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
    for (const file of files) await db.exec(`BEGIN;\n${await readFile(new URL(file, directory), 'utf8')}\nCOMMIT;`);
    expect((await db.query("SELECT to_regclass('meeting_task_exports') AS meetings,to_regclass('tickets')::text AS work,to_regclass('outreach_relationships')::text AS crm")).rows[0])
      .toEqual({ meetings: 'meeting_task_exports', work: 'tickets', crm: 'outreach_relationships' });
    expect((await db.query("SELECT value->>'enabled' AS enabled FROM app_settings WHERE key='workflow:crm-first'")).rows[0]).toEqual({ enabled: 'true' });
  } finally { await db.close(); }
});

it('leaves Meeting routes and tools out of the active contract and ignores deferred Meeting configuration', async () => {
  const config = await loadRuntimeConfig({ AI_ENV_PATH: '/tmp/antseed-telegram-only-missing.env',
    FATHOM_ENABLED: 'deferred', FATHOM_TIMEOUT_MS: 'invalid', MEETINGS_VIKUNJA_PROJECT_ID: 'invalid' });
  expect(config).not.toHaveProperty('meetings');
  expect(API_OPERATIONS.some(op => op.path.startsWith('/api/meetings'))).toBe(false);
  expect(MCP_OPERATIONS.some(op => op.tool?.includes('meeting'))).toBe(false);
  expect(MCP_OPERATIONS.some(op => op.tool === 'propose_crm_work')).toBe(true);
});
