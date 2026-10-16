import type { AppConfig } from './contracts/index.ts';
import { AppError } from './contracts/index.ts';

export type { AppConfig } from './contracts/index.ts';

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const invalid = (key: string): never => {
    throw new AppError('invalid', `Invalid configuration: ${key}`);
  };
  const number = (key: string, fallback: number, min: number, max: number): number => {
    const raw = env[key];
    const value = raw === undefined ? fallback : Number(raw);
    if (raw === '' || !Number.isSafeInteger(value) || value < min || value > max) invalid(key);
    return value;
  };
  for (const key of [
    'MODEL_BASE_URL',
    'MODEL_NAME',
    'MODEL_API_KEY',
    'MODEL_ALLOW_PUBLIC_ENDPOINT',
    'OPENAI_BASE_URL',
  ]) {
    if (env[key] !== undefined)
      throw new AppError('invalid', `Remove legacy configuration ${key}; use OPENAI_MODEL and OPENAI_API_KEY`);
  }
  const secretKey = Buffer.from(env.KANBAN_SECRET_KEY ?? '', 'base64');
  if (secretKey.length !== 32 || secretKey.toString('base64') !== env.KANBAN_SECRET_KEY) invalid('KANBAN_SECRET_KEY');
  const origin = env.KANBAN_ORIGIN ?? 'http://localhost:8787';
  try {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password)
      invalid('KANBAN_ORIGIN');
  } catch {
    invalid('KANBAN_ORIGIN');
  }
  const provider = env.MODEL_PROVIDER ?? 'openai';
  if (!['openai', 'scripted', 'disabled'].includes(provider)) invalid('MODEL_PROVIDER');
  const movement = env.MOVEMENT_PROVIDER ?? 'disabled';
  if (!['jev', 'replay', 'disabled'].includes(movement)) invalid('MOVEMENT_PROVIDER');
  if (provider !== 'scripted' && env.MODEL_SCRIPT_PATH) invalid('MODEL_SCRIPT_PATH');
  if (movement !== 'replay' && env.MOVEMENT_REPLAY_PATH) invalid('MOVEMENT_REPLAY_PATH');
  const movementEndpoint = movement === 'jev' ? (env.JEV_ENDPOINT ?? 'https://api.typesafe.ai/v1/systemone') : null;
  const gateway = movementEndpoint === 'https://ai-gateway.vercel.sh/typesafe/v1/systemone';
  const connectors: AppConfig['connectors'] = {};
  for (const channel of (env.CONNECTORS ?? 'telegram').split(',').filter(Boolean)) {
    if (!/^[a-z][a-z0-9_]*$/.test(channel)) invalid('CONNECTORS');
    connectors[channel] = {};
    for (const [key, value] of Object.entries(env)) {
      const prefix = `${channel.toUpperCase()}_`;
      if (key.startsWith(prefix) && value !== undefined) connectors[channel][key.slice(prefix.length)] = value;
    }
  }
  return {
    dataDir: env.KANBAN_DATA_DIR ?? './data',
    secretKey,
    host: env.KANBAN_HOST ?? '127.0.0.1',
    port: number('KANBAN_PORT', 8787, 1, 65535),
    origin,
    connectors,
    model: {
      provider: provider === 'disabled' ? null : (provider as 'scripted' | 'openai'),
      name: env.OPENAI_MODEL || null,
      apiKey: env.OPENAI_API_KEY || null,
      scriptPath: env.MODEL_SCRIPT_PATH || null,
      timeoutMs: number('OPENAI_TIMEOUT_MS', 30000, 1, 60000),
      maxOutputTokens: number('OPENAI_MAX_OUTPUT_TOKENS', 4096, 1, 16384),
      maxAttempts: number('OPENAI_MAX_ATTEMPTS', 2, 1, 2) as 1 | 2,
    },
    movement: {
      provider: movement === 'disabled' ? null : (movement as 'jev' | 'replay'),
      endpoint: movementEndpoint,
      model: movement === 'jev' ? (env.JEV_MODEL ?? (gateway ? 'typesafe-ai/jev' : 'jev-latest')) : null,
      apiKey: (gateway ? env.AI_GATEWAY_API_KEY : env.JEV_API_KEY) || null,
      replayPath: env.MOVEMENT_REPLAY_PATH || null,
      timeoutMs: number('JEV_TIMEOUT_MS', 10000, 1, 30000),
      maxAttempts: number('JEV_MAX_ATTEMPTS', 1, 1, 2) as 1 | 2,
    },
  };
}
