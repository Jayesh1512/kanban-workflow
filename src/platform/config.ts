import { readFile } from 'node:fs/promises';
import { parse } from 'dotenv';
import { telegramApplication } from './telegram-profile.js';
import type { RuntimeConfig } from '../shared/ports.js';

const metadata = new WeakMap<RuntimeConfig, { aiEnvReadable: boolean }>();
export const configMetadata = (config: RuntimeConfig) => metadata.get(config) ?? { aiEnvReadable: false };
const nonblank = (value: string | undefined) => value?.trim() || null;

async function readEnv(path: string): Promise<Record<string, string> | null> {
  try { return parse(await readFile(path)); }
  catch (error) {
    if (['ENOENT', 'EACCES', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw new Error('Could not read runtime configuration file');
  }
}

/** File parsing only; never shell-source, mutate process.env, or log credentials. */
export async function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): Promise<RuntimeConfig> {
  const runtime = env['RUNTIME_ENV_PATH'] ? await readEnv(env['RUNTIME_ENV_PATH']) : null;
  const aiEnvPath = env['AI_ENV_PATH'] ?? '/Users/jys/Documents/Projects/hello/.local-preview-20261012/ai.env';
  const ai = await readEnv(aiEnvPath);
  const database = env['DATABASE_ENV_PATH'] ? await readEnv(env['DATABASE_ENV_PATH']) : null;
  const access = env['ACCESS_ENV_PATH'] ? await readEnv(env['ACCESS_ENV_PATH']) : null;
  if (env['ACCESS_ENV_PATH'] && access === null) throw new Error('Could not read access configuration file');
  if (env['DATABASE_ENV_PATH'] && database === null) throw new Error('Could not read database configuration file');
  if (env['DATABASE_ENV_PATH'] && !nonblank(database?.['DATABASE_URL'])) throw new Error('Database configuration file must contain DATABASE_URL');
  const values: NodeJS.ProcessEnv = { ...runtime, ...ai, ...database, ...access, ...env };
  // Optional blank Compose fields must preserve mounted configuration.
  for (const key of ['TELEGRAM_APPLICATION_PROFILE', 'TELEGRAM_API_ID', 'TELEGRAM_API_HASH', 'MOVEMENT_PROVIDER', 'JEV_ENDPOINT', 'JEV_MODEL', 'OPENAI_TIMEOUT_MS', 'OPENAI_MAX_OUTPUT_TOKENS']) values[key] = nonblank(env[key]) ?? nonblank(ai?.[key]) ?? nonblank(runtime?.[key]) ?? undefined;
  const str = (key: string, fallback: string) => nonblank(values[key]) ?? fallback;
  const int = (key: string, fallback: number, max = 2_147_483_647) => {
    const raw = nonblank(values[key]);
    const n = raw === null ? fallback : Number(raw);
    if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`Invalid ${key}: expected a positive integer`);
    return n;
  };
  const url = (key: string, fallback: string, protocols: string[]) => {
    const raw = str(key, fallback);
    try { const u = new URL(raw); if (!protocols.includes(u.protocol)) throw new Error(); }
    catch { throw new Error(`Invalid ${key}: unsupported URL`); }
    return raw;
  };
  if (str('MODEL_PROVIDER', 'openai') !== 'openai') throw new Error('MODEL_PROVIDER must be openai');
  const movement = str('MOVEMENT_PROVIDER', 'jev');
  if (!['jev', 'vercel', 'openai'].includes(movement)) throw new Error('MOVEMENT_PROVIDER must select openai or vercel');
  const provider = movement === 'openai' ? 'openai' : 'vercel';
  const expectedEndpoint = provider === 'openai' ? 'https://api.openai.com/v1/decisions' : 'https://ai-gateway.vercel.sh/typesafe/v1/systemone';
  const endpoint = url('JEV_ENDPOINT', expectedEndpoint, ['https:']);
  if (endpoint !== expectedEndpoint) throw new Error('JEV_ENDPOINT must match the selected decision provider endpoint');
  const model = str('JEV_MODEL', provider === 'openai' ? 'gpt-6-luna' : 'typesafe-ai/jev');
  if (provider === 'openai' && model !== 'gpt-6-luna') throw new Error('OpenAI Decisions requires JEV_MODEL=gpt-6-luna');
  const timezone = str('TIMEZONE', 'Asia/Kolkata');
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); }
  catch { throw new Error('Invalid TIMEZONE'); }
  const config: RuntimeConfig = {
    boardBackend: str('BOARD_BACKEND', 'native') as 'native' | 'vikunja',
    access: {
      supabaseUrl: nonblank(values['SUPABASE_URL']),
      publishableKey: nonblank(values['SUPABASE_PUBLISHABLE_KEY']) ?? nonblank(values['SUPABASE_ANON_KEY']),
      adminEmail: nonblank(values['WORKSPACE_ADMIN_EMAIL'])?.toLowerCase() ?? null,
      appUrl: url('APP_URL', `http://localhost:${str('PORT', '3000')}`, ['http:', 'https:']).replace(/\/$/, ''),
      crmApproval: str('CRM_APPROVAL', 'direct') as 'direct' | 'telegram',
    },
    http: { host: str('HOST', '127.0.0.1'), port: int('PORT', 3000, 65535) },
    databaseUrl: url('DATABASE_URL', 'postgresql://antseed:antseed@127.0.0.1:5432/antseed', ['postgres:', 'postgresql:']),
    timezone, aiEnvPath,
    telegram: {
      ...telegramApplication(values), sessionPath: str('TELEGRAM_SESSION_PATH', '/data/telegram/client.session'),
      historyBatchSize: int('TELEGRAM_HISTORY_BATCH_SIZE', 20, 100), historyMaxBatches: int('TELEGRAM_HISTORY_MAX_BATCHES', 10, 10_000),
      discoveryBatchSize: int('TELEGRAM_DISCOVERY_BATCH_SIZE', 500, 500),
    },
    vikunja: {
      baseUrl: url('VIKUNJA_URL', 'http://127.0.0.1:3456', ['http:', 'https:']).replace(/\/$/, ''),
      apiToken: nonblank(values['VIKUNJA_API_TOKEN']), username: str('VIKUNJA_USERNAME', 'antseed'),
      publicUrl: url('VIKUNJA_PUBLIC_URL',str('VIKUNJA_URL','http://127.0.0.1:3456'),['http:','https:']).replace(/\/$/, ''),
      password: nonblank(values['VIKUNJA_PASSWORD']), projectTitle: str('VIKUNJA_PROJECT_TITLE', 'AntSeed'),
      // Native task enrichment makes several database round trips. An external
      // database needs a bounded WAN budget rather than the local ten seconds.
      timeoutMs: int('VIKUNJA_TIMEOUT_MS', env['DATABASE_ENV_PATH'] ? 45_000 : 10_000, 120_000),
    },
    extraction: { provider: 'openai', model: str('OPENAI_MODEL', 'gpt-6.1-sol'), apiKey: nonblank(values['OPENAI_API_KEY']), timeoutMs: int('OPENAI_TIMEOUT_MS', 30_000), maxAttempts: int('OPENAI_MAX_ATTEMPTS', 2, 10), maxOutputTokens: int('OPENAI_MAX_OUTPUT_TOKENS', 4096, 100_000) },
    jev: { provider, endpoint, model, apiKey: provider === 'openai' ? nonblank(values['OPENAI_API_KEY']) : nonblank(values['JEV_API_KEY']) ?? nonblank(values['AI_GATEWAY_API_KEY']), timeoutMs: int('JEV_TIMEOUT_MS', 10_000), maxAttempts: int('JEV_MAX_ATTEMPTS', 1, 10) },
  };
  if (!['native', 'vikunja'].includes(config.boardBackend!)) throw new Error('Invalid BOARD_BACKEND');
  if (!['direct', 'telegram'].includes(config.access!.crmApproval)) throw new Error('Invalid CRM_APPROVAL');
  if (config.access!.supabaseUrl) {
    const authUrl = new URL(config.access!.supabaseUrl);
    if (authUrl.protocol !== 'https:' || authUrl.username || authUrl.password || authUrl.pathname !== '/' || authUrl.search || authUrl.hash)
      throw new Error('SUPABASE_URL must be an HTTPS project origin');
  }
  metadata.set(config, { aiEnvReadable: ai !== null });
  return config;
}
