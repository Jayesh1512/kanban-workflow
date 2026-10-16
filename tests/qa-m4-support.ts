import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { buildApp } from '../src/app.js';
import { createPlatformModule } from '../src/platform/module.js';
import { createWorkflowModule } from '../src/workflow/module.js';
import { fixture } from './qa-m32-support.js';

export const project = process.env['QA_M4_PROJECT'];
/** Official SDK client, independently constructed; exact optional callback bridge only. */
export async function sdk(url: string) {
  const client = new Client({ name: 'antseed-independent-qa', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', url));
  const bridge: Transport = { start: () => transport.start(), send: (m, o) => transport.send(m, o), close: () => transport.close(), setProtocolVersion: (v) => transport.setProtocolVersion(v) };
  transport.onmessage = (m) => bridge.onmessage?.(m); transport.onclose = () => bridge.onclose?.(); transport.onerror = (e) => bridge.onerror?.(e);
  await client.connect(bridge); return client;
}
export function value(raw: unknown): any { return JSON.parse((raw as { content: Array<{ text: string }> }).content[0]!.text); }
export async function canonicalFixture(options?: { databasePort?: number }) {
  if (!project || project !== process.env['QA_M32_PROJECT']) throw new Error('M4 requires explicit identical QA_M4_PROJECT/QA_M32_PROJECT');
  const h = await fixture(false), dir = await mkdtemp(join(tmpdir(), 'antseed-qa-m4-session-'));
  const config = structuredClone(h.config); config.databaseUrl = h.db.pool.options.connectionString!;
  if(options?.databasePort) { const u=new URL(config.databaseUrl);u.port=String(options.databasePort);config.databaseUrl=u.toString(); }
  config.telegram.sessionPath = join(dir, 'fresh-no-account.session'); config.jev.apiKey = 'QA-M4-synthetic-paused';
  const platform = await createPlatformModule(config), workflow = await createWorkflowModule(platform.services);
  const app = await buildApp({ modules: [platform, workflow] });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  for (let i = 0; i < 200; i++) { const r = await app.inject('/api/status'); if (r.json().components.database.state === 'ready') break; await new Promise((r) => setTimeout(r, 10)); }
  return { h, config, platform, workflow, app, url, async close() { try { await app.close(); } finally { await rm(dir, { recursive: true, force: true }); await h.close(); } } };
}
