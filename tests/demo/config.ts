import { execFileSync } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative } from 'node:path';
import { z } from 'zod';
import { parse } from 'dotenv';
import { loadRuntimeConfig } from '../../src/platform/config.js';

export class DemoError extends Error {}
const port = z.number().int().min(1024).max(65535);
export const manifestSchema = z.object({ project: z.string().regex(/^antseed-pm-demo-[a-z0-9][a-z0-9-]{5,60}$/), directory: z.string(), override: z.string(), aiEnv: z.string(), ports: z.object({ backend: port, vikunja: port, postgres: port }), sourceCommit: z.string().optional() }).refine((v) => new Set(Object.values(v.ports)).size === 3, 'Demo ports must differ');
export type DemoManifest = z.infer<typeof manifestSchema>;
export async function loadManifest(path: string): Promise<DemoManifest> {
  if (!isAbsolute(path)) throw new DemoError('Use an absolute PM manifest path');
  const m = manifestSchema.parse(JSON.parse(await readFile(path, 'utf8'))); const directory = await realpath(m.directory);
  if (dirname(await realpath(path)) !== directory || !isAbsolute(m.override) || !isAbsolute(m.aiEnv)) throw new DemoError('Manifest/override/AI paths must belong to the explicit PM directory');
  for (const file of [m.override, m.aiEnv]) { const r = relative(directory, await realpath(file)); if (r.startsWith('..') || isAbsolute(r)) throw new DemoError('Demo input escaped PM directory'); }
  // Never read the user's AI file; the PM's explicit empty file is the only input.
  const ai = parse(await readFile(m.aiEnv));
  if (['OPENAI_API_KEY', 'JEV_API_KEY', 'AI_GATEWAY_API_KEY', 'TELEGRAM_API_ID', 'TELEGRAM_API_HASH'].some((key) => ai[key]?.trim())) throw new DemoError('Demo manifest must reference an empty-provider/custom-Telegram environment');
  return m;
}
export function docker(m: DemoManifest, args: string[]): string {
  try { return execFileSync('docker', ['compose', '-p', m.project, '-f', 'compose.yaml', '-f', m.override, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
    env: { ...process.env, COMPOSE_PROJECT_NAME: m.project, AI_ENV_PATH: m.aiEnv, BACKEND_PORT: String(m.ports.backend), VIKUNJA_PORT: String(m.ports.vikunja), TELEGRAM_APPLICATION_PROFILE: 'custom', TELEGRAM_API_ID: '', TELEGRAM_API_HASH: '' } }); }
  catch { throw new DemoError('Owned demo Docker read failed; verify manifest, project and running services (details suppressed)'); }
}
export function inspectInventory(m: DemoManifest, text: string, seeding: boolean): void {
  const parsed: unknown = text.trim().startsWith('[') ? JSON.parse(text) : text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const rows = z.array(z.object({ Project: z.string(), Service: z.string(), State: z.string(), Publishers: z.array(z.object({ URL: z.string(), TargetPort: z.number(), PublishedPort: z.number() })).nullable().optional() })).parse(parsed);
  if (rows.some((r) => r.Project !== m.project)) throw new DemoError('Docker project ownership mismatch');
  for (const [service, target, published] of [['postgres', 5432, m.ports.postgres], ['vikunja', 3456, m.ports.vikunja], ...(!seeding ? [['backend', 3000, m.ports.backend] as const] : [])] as const) {
    const row = rows.find((r) => r.Service === service);
    if (!row || row.State !== 'running' || !row.Publishers?.some((p) => p.TargetPort === target && p.PublishedPort === published && p.URL === '127.0.0.1')) throw new DemoError('Expected owned running service on its explicit loopback port');
  }
  if (seeding && rows.some((r) => r.Service === 'backend' && r.State === 'running')) throw new DemoError('Stop ONLY this PM demo backend before seed; restart after seed so the canonical worker owns projection/apply');
}
export async function runtimeConfig(m: DemoManifest) {
  const bundle = parse(docker(m, ['exec', '-T', 'vikunja', 'cat', '/run/antseed/runtime.env']));
  const db = new URL(bundle['DATABASE_URL']!); if (db.hostname !== 'postgres' || db.port !== '5432' || db.pathname !== '/antseed') throw new DemoError('Unexpected generated demo database binding');
  db.hostname = '127.0.0.1'; db.port = String(m.ports.postgres);
  return loadRuntimeConfig({ ...bundle, DATABASE_URL: db.toString(), AI_ENV_PATH: m.aiEnv, OPENAI_API_KEY: '', AI_GATEWAY_API_KEY: '', JEV_API_KEY: '', TELEGRAM_APPLICATION_PROFILE: 'custom', TELEGRAM_API_ID: '', TELEGRAM_API_HASH: '', VIKUNJA_URL: `http://127.0.0.1:${m.ports.vikunja}`, TELEGRAM_SESSION_PATH: `${m.directory}/never-open-demo.session`, TIMEZONE: 'Asia/Kolkata' });
}
