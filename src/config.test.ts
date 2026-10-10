import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from './config.ts';
import { AppError } from './contracts/index.ts';

const syntheticKey = Buffer.alloc(32, 7).toString('base64');

test('F0 R27 config defaults OpenAI with no selected model and separate disabled movement', () => {
  const cfg = loadConfig({ KANBAN_SECRET_KEY: syntheticKey });
  assert.equal(cfg.model.provider, 'openai');
  assert.equal(cfg.model.name, null);
  assert.equal(cfg.model.apiKey, null);
  assert.equal(cfg.model.timeoutMs, 30000);
  assert.equal(cfg.model.maxOutputTokens, 4096);
  assert.equal(cfg.model.maxAttempts, 2);
  assert.equal(cfg.movement.provider, null);
  assert.equal(cfg.movement.timeoutMs, 10000);
  assert.equal(cfg.movement.maxAttempts, 1);
  assert.equal(loadConfig({ KANBAN_SECRET_KEY: syntheticKey, MODEL_PROVIDER: 'disabled' }).model.provider, null);
});

test('F0 R27 bad config and old arbitrary endpoints report variable names without secrets', () => {
  for (const [key, value] of Object.entries({
    KANBAN_SECRET_KEY: 'synthetic-secret',
    OPENAI_TIMEOUT_MS: '60001',
    OPENAI_MAX_ATTEMPTS: '3',
    JEV_TIMEOUT_MS: '0',
    MODEL_PROVIDER: 'local',
    MODEL_BASE_URL: 'synthetic-secret',
  })) {
    assert.throws(
      () => loadConfig({ KANBAN_SECRET_KEY: syntheticKey, [key]: value }),
      (err) => err instanceof AppError && err.message.includes(key) && !err.message.includes('synthetic-secret'),
    );
  }
});
