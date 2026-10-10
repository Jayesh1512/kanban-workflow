import assert from 'node:assert/strict';
import test from 'node:test';
import { createModel, createMovementProvider } from '../src/agent/index.ts';
import { loadConfig } from '../src/config.ts';
import { AppConfigSchema } from '../src/contracts/index.ts';
import { openDb } from '../src/store/index.ts';
import { createOpenAIResponsesPort } from '../src/store/provider-ports.ts';
import { testApp } from './harness.ts';

const env = { KANBAN_SECRET_KEY: Buffer.alloc(32, 7).toString('base64') };

test('I1 R27.5/9 config uses named providers, no selected OpenAI model, bounded defaults and safe variable-only errors', async () => {
  const cfg = loadConfig(env);
  assert.ok(AppConfigSchema.safeParse(cfg).success);
  assert.deepEqual(cfg.model, {
    provider: 'openai',
    name: null,
    apiKey: null,
    scriptPath: null,
    timeoutMs: 30000,
    maxOutputTokens: 4096,
    maxAttempts: 2,
  });
  assert.equal(cfg.movement.provider, null);
  assert.equal(cfg.movement.timeoutMs, 10000);
  assert.equal(cfg.movement.maxAttempts, 1);
  const hosted = loadConfig({ ...env, MOVEMENT_PROVIDER: 'jev' });
  assert.equal(hosted.movement.endpoint, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(hosted.movement.model, 'jev-latest');
  for (const [key, value] of Object.entries({
    MODEL_PROVIDER: 'private-invalid-marker',
    MODEL_BASE_URL: 'private-invalid-marker',
    OPENAI_BASE_URL: 'private-invalid-marker',
    OPENAI_TIMEOUT_MS: '60001',
    OPENAI_MAX_OUTPUT_TOKENS: '16385',
    OPENAI_MAX_ATTEMPTS: '3',
    JEV_TIMEOUT_MS: '30001',
    JEV_MAX_ATTEMPTS: '0',
    MOVEMENT_PROVIDER: 'other',
    KANBAN_SECRET_KEY: 'private-invalid-marker',
    KANBAN_ORIGIN: 'https://private-invalid-marker/path',
  })) {
    assert.throws(
      () => loadConfig({ ...env, [key]: value }),
      (error) =>
        error instanceof Error && error.message.includes(key) && !error.message.includes('private-invalid-marker'),
    );
  }
  assert.throws(() => loadConfig({ ...env, MODEL_SCRIPT_PATH: 'synthetic' }), /MODEL_SCRIPT_PATH/);
  assert.throws(
    () => loadConfig({ ...env, MOVEMENT_PROVIDER: 'jev', MOVEMENT_REPLAY_PATH: 'synthetic' }),
    /MOVEMENT_REPLAY_PATH/,
  );
  const db = openDb(':memory:');
  try {
    assert.equal(
      createOpenAIResponsesPort(cfg.model, async () => {
        throw new Error('must not send');
      }),
      undefined,
    );
    const disabled = await createModel({ ...cfg.model, provider: null }, { db, oplog: () => {} });
    assert.equal(disabled.blocked, 'no_model');
    const movement = await createMovementProvider(cfg.movement, {
      db,
      oplog: () => {},
      now: () => new Date('2026-10-10T00:00:00.000Z'),
      sleep: async () => {},
      http: {
        async post() {
          throw new Error('must not send');
        },
      },
    });
    assert.deepEqual(movement.status(), {
      provider: null,
      execution: 'disabled',
      state: 'blocked',
      reason: 'missing_config',
      endpointHost: null,
      model: null,
    });
  } finally {
    db.close();
  }
});

test('I1 factory source exclusivity and harness file-backed restart preserve durable credentials/settings without shared instance state', async (t) => {
  const db = openDb(':memory:');
  const cfg = loadConfig({ ...env, MODEL_PROVIDER: 'scripted', MODEL_SCRIPT_PATH: 'synthetic' });
  await assert.rejects(createModel(cfg.model, { db, oplog: () => {}, scriptLines: [] }), /one scripted source/);
  db.close();
  const first = await testApp({ teammates: [{ username: 'alice' }], settings: { review_threshold: 0.8 } });
  const second = await testApp({ teammates: [{ username: 'bob' }] });
  t.after(async () => {
    await first.app.stop();
    first.close();
    await second.app.stop();
    second.close();
  });
  const oldDb = first.db;
  const oldApp = first.app;
  const token = first.tokenFor({ name: 'durable-reader', scopeMessages: false });
  const cookie = first.cookieFor('alice');
  assert.equal(first.db.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode, 'wal');
  await first.restart();
  assert.notEqual(first.db, oldDb);
  assert.notEqual(first.app, oldApp);
  assert.throws(() => oldDb.get('SELECT 1'), /not open/);
  assert.equal(first.db.get<{ value: string }>("SELECT value FROM setting WHERE key='review_threshold'")?.value, '0.8');
  assert.equal((await first.get('/board', { cookie })).status, 200);
  assert.equal((await first.get('/board')).status, 303);
  assert.ok(token.startsWith('kbn_'));
  assert.equal(second.db.all('SELECT * FROM credential').length, 0);
  assert.equal(second.db.all('SELECT * FROM setting').length, 0);
  assert.equal(second.clock.now().toISOString(), '2026-09-01T10:00:00.000Z');
  first.clock.advance(1000);
  assert.notEqual(first.clock.now().toISOString(), second.clock.now().toISOString());
});

test('I1 R26.2 root CLI creates first teammate locally with a once-shown password and hash-only durable storage', async () => {
  const { execFile } = await import('node:child_process');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'kanban-cli-i1-'));
  try {
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        ['src/cli.ts', 'teammate:add', 'first'],
        {
          cwd: new URL('..', import.meta.url),
          env: { PATH: process.env.PATH, KANBAN_SECRET_KEY: env.KANBAN_SECRET_KEY, KANBAN_DATA_DIR: dir },
        },
        (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr })),
      );
      child.stdin?.end('First teammate\n');
    });
    const password = /^Initial password \(shown once\): ([A-Za-z0-9_-]+)\n$/.exec(result.stdout)?.[1];
    assert.ok(password);
    assert.ok(!result.stderr.includes(password));
    const db = openDb(join(dir, 'kanban.db'));
    try {
      const { signIn, teammateForSession } = await import('../src/auth/index.ts');
      const at = new Date('2026-10-10T12:00:00.000Z');
      const session = signIn(db, 'first', password, at);
      assert.equal(teammateForSession(db, session.token, at), 1);
      assert.ok(!JSON.stringify(db.all('SELECT * FROM teammate')).includes(password));
      assert.equal(db.get<{ action: string }>('SELECT action FROM action_log')?.action, 'teammate.add');
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
