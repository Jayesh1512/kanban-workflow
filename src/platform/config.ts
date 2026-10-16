import { readFile } from 'node:fs/promises';
import { parse } from 'dotenv';
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
  const values: NodeJS.ProcessEnv = { ...runtime, ...ai, ...env };
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
  if (!['jev', 'vercel'].includes(str('MOVEMENT_PROVIDER', 'jev'))) throw new Error('MOVEMENT_PROVIDER must select Jev through Vercel');
  const endpoint = url('JEV_ENDPOINT', 'https://ai-gateway.vercel.sh/typesafe/v1/systemone', ['https:']);
  if (new URL(endpoint).hostname !== 'ai-gateway.vercel.sh') throw new Error('JEV_ENDPOINT must use Vercel AI Gateway');
  const timezone = str('TIMEZONE', 'Asia/Kolkata');
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); }
  catch { throw new Error('Invalid TIMEZONE'); }
  const config: RuntimeConfig = {
    http: { host: str('HOST', '127.0.0.1'), port: int('PORT', 3000, 65535) },
    databaseUrl: url('DATABASE_URL', 'postgresql://antseed:antseed@127.0.0.1:5432/antseed', ['postgres:', 'postgresql:']),
    timezone, aiEnvPath,
    telegram: {
      apiId: nonblank(values['TELEGRAM_API_ID']) ? int('TELEGRAM_API_ID', 1) : null,
      apiHash: nonblank(values['TELEGRAM_API_HASH']), sessionPath: str('TELEGRAM_SESSION_PATH', '/data/telegram/client.session'),
      historyBatchSize: int('TELEGRAM_HISTORY_BATCH_SIZE', 100, 100), historyMaxBatches: int('TELEGRAM_HISTORY_MAX_BATCHES', 10, 10_000),
    },
    vikunja: {
      baseUrl: url('VIKUNJA_URL', 'http://127.0.0.1:3456', ['http:', 'https:']).replace(/\/$/, ''),
      apiToken: nonblank(values['VIKUNJA_API_TOKEN']), username: str('VIKUNJA_USERNAME', 'antseed'),
      password: nonblank(values['VIKUNJA_PASSWORD']), projectTitle: str('VIKUNJA_PROJECT_TITLE', 'AntSeed'),
    },
    extraction: { provider: 'openai', model: str('OPENAI_MODEL', 'gpt-6.1-sol'), apiKey: nonblank(values['OPENAI_API_KEY']), timeoutMs: int('OPENAI_TIMEOUT_MS', 30_000), maxAttempts: int('OPENAI_MAX_ATTEMPTS', 2, 10), maxOutputTokens: int('OPENAI_MAX_OUTPUT_TOKENS', 4096, 100_000) },
    jev: { provider: 'vercel', endpoint, model: str('JEV_MODEL', 'typesafe-ai/jev'), apiKey: nonblank(values['JEV_API_KEY']) ?? nonblank(values['AI_GATEWAY_API_KEY']), timeoutMs: int('JEV_TIMEOUT_MS', 10_000), maxAttempts: int('JEV_MAX_ATTEMPTS', 1, 10) },
  };
  metadata.set(config, { aiEnvReadable: ai !== null });
  return config;
}
