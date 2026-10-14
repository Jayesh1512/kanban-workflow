import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createModel, createMovementProvider } from '../src/agent/index.ts';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { App, AppDeps, ModelConfig, SqlValue } from '../src/contracts/index.ts';
import { AppError } from '../src/contracts/index.ts';
import { openDb } from '../src/store/index.ts';

// Construction observations only: an empty database cannot prove a runtime retry budget.
async function emptyDependencies(
  env: Record<string, string | undefined> = {},
): Promise<{ deps: AppDeps; effects: string[] }> {
  const config = loadConfig({
    KANBAN_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
    CONNECTORS: '',
    MODEL_PROVIDER: 'scripted',
    MOVEMENT_PROVIDER: 'replay',
    ...env,
  });
  const db = openDb(':memory:');
  const effects: string[] = [];
  const now = () => {
    effects.push('now');
    return new Date('2026-10-12T00:00:00.000Z');
  };
  const sleep = async () => {
    effects.push('sleep');
  };
  const oplog = () => {
    effects.push('oplog');
  };
  try {
    const model = await createModel(config.model, {
      db,
      oplog,
      ...(config.model.provider === 'scripted' ? { scriptLines: [] } : {}),
    });
    const movement = await createMovementProvider(config.movement, {
      db,
      now,
      sleep,
      oplog,
      http: {
        async post() {
          effects.push('movement.http');
          throw new Error('External network blocked in construction test');
        },
      },
      ...(config.movement.provider === 'replay' ? { replayLines: [] } : {}),
    });
    // Observe calls on the actual migrated Db and actual factory-produced providers.
    const get = db.get;
    const all = db.all;
    const run = db.run;
    const tx = db.tx;
    const close = db.close;
    const registerAgentCancellation = db.registerAgentCancellation;
    const invalidateAgentWork = db.invalidateAgentWork;
    db.get = <T>(sql: string, ...params: SqlValue[]): T | undefined => {
      effects.push('db.get');
      return get<T>(sql, ...params);
    };
    db.all = <T>(sql: string, ...params: SqlValue[]): T[] => {
      effects.push('db.all');
      return all<T>(sql, ...params);
    };
    db.run = (sql, ...params) => {
      effects.push('db.run');
      return run(sql, ...params);
    };
    db.tx = <T>(fn: () => T): T => {
      effects.push('db.tx');
      return tx(fn);
    };
    db.close = () => {
      effects.push('db.close');
      close();
    };
    db.registerAgentCancellation = (scope, controller) => {
      effects.push('db.registerAgentCancellation');
      return registerAgentCancellation(scope, controller);
    };
    db.invalidateAgentWork = (scope) => {
      effects.push('db.invalidateAgentWork');
      invalidateAgentWork(scope);
    };
    const decide = model.decide;
    model.decide = async (input, signal) => {
      effects.push('model.decide');
      return decide(input, signal);
    };
    const movementDecide = movement.decide;
    const movementStatus = movement.status;
    movement.decide = async (request, signal) => {
      effects.push('movement.decide');
      return movementDecide(request, signal);
    };
    movement.status = () => {
      effects.push('movement.status');
      return movementStatus();
    };
    const deps: AppDeps = { db, config, model, movement, now, sleep, oplog, connectors: [] };
    // Actual Host createState spreads deps. This observes entry without replacing a factory.
    Object.defineProperty(deps, 'connectors', {
      enumerable: true,
      get() {
        effects.push('component.connectors');
        return [];
      },
    });
    assert.deepEqual(effects, []);
    return { deps, effects };
  } catch (error) {
    db.close();
    throw error;
  }
}

function observePolicy(deps: AppDeps, value: ModelConfig['maxAttempts']) {
  let reads = 0;
  Object.defineProperty(deps.config.model, 'maxAttempts', {
    configurable: true,
    enumerable: true,
    get() {
      reads++;
      return value;
    },
  });
  return () => reads;
}

function forbidPolicyRead(deps: AppDeps) {
  Object.defineProperty(deps.config.model, 'maxAttempts', {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error('Constructed app reread mutable attempt policy');
    },
  });
}

async function operateOnEmptyApp(app: App, deps: AppDeps) {
  assert.equal(deps.db.get<{ n: number }>('SELECT count(*) AS n FROM message')?.n, 0);
  assert.equal(await app.pipeline.processNext(), null);
  assert.equal(await app.pipeline.drain(), 0);
  assert.equal(app.pipeline.status().pending, 0);
  assert.deepEqual(app.host.listChannels(), []);
  await app.host.settle();
  const login = await app.fetch(new Request(`${deps.config.origin}/login`));
  assert.equal(login.status, 200);
  assert.match(await login.text(), /Sign in/);
  const mcp = await app.fetch(new Request(`${deps.config.origin}/mcp`, { method: 'POST' }));
  assert.equal(mcp.status, 401);
  assert.equal(deps.db.get<{ n: number }>('SELECT count(*) AS n FROM decision')?.n, 0);
}

const legalPolicies: { label: string; env: Record<string, string | undefined>; expected: 1 | 2 }[] = [
  { label: 'configured1', env: { OPENAI_MAX_ATTEMPTS: '1' }, expected: 1 },
  { label: 'configured2', env: { OPENAI_MAX_ATTEMPTS: '2' }, expected: 2 },
  { label: 'absent-default2', env: {}, expected: 2 },
];

for (const policy of legalPolicies) {
  test(`A1 construction ${policy.label}: actual loadConfig/createApp reads once and empty operations do not reread`, async () => {
    const { deps, effects } = await emptyDependencies(policy.env);
    let app: App | undefined;
    try {
      assert.equal(deps.config.model.maxAttempts, policy.expected);
      const reads = observePolicy(deps, policy.expected);
      app = createApp(deps);
      assert.equal(reads(), 1);
      assert.ok(effects.includes('component.connectors'));
      assert.deepEqual(
        effects.filter((effect) => effect !== 'component.connectors'),
        [],
      );
      forbidPolicyRead(deps);
      await operateOnEmptyApp(app, deps);
      await app.stop();
      assert.equal(reads(), 1);
      assert.ok(!effects.includes('model.decide'));
      assert.ok(!effects.includes('movement.decide'));
      assert.ok(!effects.includes('movement.http'));
      assert.ok(!effects.includes('sleep'));
    } finally {
      if (app) await app.stop();
      deps.db.close();
    }
  });
}

const invalidPolicies: { label: string; value: unknown }[] = [
  { label: 'undefined', value: undefined },
  { label: 'null', value: null },
  { label: 'string1', value: '1' },
  { label: 'string2', value: '2' },
  { label: 'secret-string', value: 'private-policy-marker' },
  { label: 'true', value: true },
  { label: 'false', value: false },
  { label: 'object', value: {} },
  { label: 'array', value: [1] },
  { label: 'fraction', value: 1.5 },
  { label: 'NaN', value: Number.NaN },
  { label: 'Infinity', value: Number.POSITIVE_INFINITY },
  { label: 'negative-Infinity', value: Number.NEGATIVE_INFINITY },
  { label: 'zero', value: 0 },
  { label: 'three', value: 3 },
  { label: 'negative', value: -1 },
  { label: 'bigint', value: 1n },
  { label: 'symbol', value: Symbol('private-policy-marker') },
];

function fixedInvalidPolicy(error: unknown): boolean {
  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'invalid');
  assert.equal(error.message, 'Invalid pipeline modelMaxAttempts');
  return true;
}

for (const policy of invalidPolicies) {
  test(`A1 construction invalid ${policy.label}: actual constructor rejects before Host and dependency effects`, async () => {
    const { deps, effects } = await emptyDependencies();
    try {
      assert.ok(Reflect.set(deps.config.model, 'maxAttempts', policy.value));
      assert.throws(() => createApp(deps), fixedInvalidPolicy);
      assert.deepEqual(effects, []);
    } finally {
      deps.db.close();
    }
  });
}

test('A1 construction missing programmatic policy has no constructor fallback or dependency effects', async () => {
  const { deps, effects } = await emptyDependencies();
  try {
    assert.ok(Reflect.deleteProperty(deps.config.model, 'maxAttempts'));
    assert.throws(() => createApp(deps), fixedInvalidPolicy);
    assert.deepEqual(effects, []);
  } finally {
    deps.db.close();
  }
});

test('A1 construction does not coerce an object policy and preserves throwing-getter exceptions', async () => {
  const { deps, effects } = await emptyDependencies();
  try {
    const supplied = new Error('Synthetic getter exception');
    const coercible = {
      valueOf() {
        effects.push('policy.coercion');
        return 1;
      },
      toString() {
        effects.push('policy.coercion');
        return '1';
      },
    };
    assert.ok(Reflect.set(deps.config.model, 'maxAttempts', coercible));
    assert.throws(() => createApp(deps), fixedInvalidPolicy);
    assert.deepEqual(effects, []);
    let reads = 0;
    Object.defineProperty(deps.config.model, 'maxAttempts', {
      get() {
        reads++;
        throw supplied;
      },
    });
    assert.throws(
      () => createApp(deps),
      (error) => error === supplied,
    );
    assert.equal(reads, 1);
    assert.deepEqual(effects, []);
  } finally {
    deps.db.close();
  }
});

test('A1 construction validation also precedes effects for an actual disabled Model', async () => {
  const { deps, effects } = await emptyDependencies({ MODEL_PROVIDER: 'disabled', MOVEMENT_PROVIDER: 'disabled' });
  try {
    assert.equal(deps.model.blocked, 'no_model');
    assert.ok(Reflect.set(deps.config.model, 'maxAttempts', 3));
    assert.throws(() => createApp(deps), fixedInvalidPolicy);
    assert.deepEqual(effects, []);
  } finally {
    deps.db.close();
  }
});

test('A1 construction fresh app captures changed config after the old empty instance stops', async () => {
  const { deps } = await emptyDependencies({ OPENAI_MAX_ATTEMPTS: '1' });
  let old: App | undefined;
  let fresh: App | undefined;
  try {
    const oldReads = observePolicy(deps, 1);
    old = createApp(deps);
    assert.equal(oldReads(), 1);
    forbidPolicyRead(deps);
    await operateOnEmptyApp(old, deps);
    await old.stop();
    const freshReads = observePolicy(deps, 2);
    fresh = createApp(deps);
    assert.notEqual(fresh, old);
    assert.notEqual(fresh.pipeline, old.pipeline);
    assert.notEqual(fresh.host, old.host);
    assert.equal(freshReads(), 1);
    assert.equal(oldReads(), 1);
    forbidPolicyRead(deps);
    await operateOnEmptyApp(fresh, deps);
    await fresh.stop();
    assert.equal(freshReads(), 1);
    assert.equal(oldReads(), 1);
  } finally {
    if (old) await old.stop();
    if (fresh) await fresh.stop();
    deps.db.close();
  }
});

test('A1 construction two concurrent cfg1/cfg2 apps with the same opaque Model read their own config once', async () => {
  const first = await emptyDependencies({ OPENAI_MAX_ATTEMPTS: '1' });
  let second: Awaited<ReturnType<typeof emptyDependencies>> | undefined;
  const apps: App[] = [];
  try {
    second = await emptyDependencies({ OPENAI_MAX_ATTEMPTS: '2' });
    second.deps.model = first.deps.model;
    assert.equal(first.deps.model, second.deps.model);
    assert.notEqual(first.deps.db, second.deps.db);
    const firstReads = observePolicy(first.deps, 1);
    const secondReads = observePolicy(second.deps, 2);
    await Promise.all(
      [first, second].map(async ({ deps }) => {
        apps.push(createApp(deps));
      }),
    );
    assert.equal(firstReads(), 1);
    assert.equal(secondReads(), 1);
    forbidPolicyRead(first.deps);
    forbidPolicyRead(second.deps);
    assert.equal(apps.length, 2);
    await Promise.all([
      ...apps.map((app) => app.pipeline.processNext().then((id) => assert.equal(id, null))),
      ...apps.map((app) => app.pipeline.drain().then((n) => assert.equal(n, 0))),
    ]);
    for (const app of apps) assert.equal(app.pipeline.status().pending, 0);
    assert.equal(firstReads(), 1);
    assert.equal(secondReads(), 1);
    for (const { effects } of [first, second]) {
      assert.ok(!effects.includes('model.decide'));
      assert.ok(!effects.includes('movement.decide'));
      assert.ok(!effects.includes('movement.http'));
    }
  } finally {
    await Promise.all(apps.map((app) => app.stop()));
    first.deps.db.close();
    second?.deps.db.close();
  }
});

test('A1 construction source pins the exact config-to-required-primitive literal before Host', () => {
  const source = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export function createApp(deps: AppDeps): App {');
  const end = source.indexOf('  const web = createWeb(', start);
  assert.ok(start >= 0 && end > start);
  assert.equal(
    source.slice(start, end),
    `export function createApp(deps: AppDeps): App {
  const pipeline = createPipeline({
    db: deps.db,
    model: deps.model,
    modelMaxAttempts: deps.config.model.maxAttempts,
    movement: deps.movement,
    now: deps.now,
    sleep: deps.sleep,
    oplog: deps.oplog,
  });
  const host = createHost(deps);
`,
  );
});
