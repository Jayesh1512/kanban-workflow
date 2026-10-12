import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { loadConfig } from '../config.ts';
import type { Db, Model, ModelConfig, MovementDecisionProvider, Pipeline } from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';
import { openDb } from '../store/index.ts';
import { createModel, createMovementProvider, createPipeline } from './index.ts';
import { createPipeline as reexportedPipeline } from './pipeline.ts';

// Boundary observations only; no empty-state test proves retry consumption in the thin spine.
function inertDependencies(modelMaxAttempts: ModelConfig['maxAttempts']) {
  const effects: string[] = [];
  function unexpected(effect: string): never {
    effects.push(effect);
    throw new Error(`Unexpected construction effect: ${effect}`);
  }
  const db: Db = {
    get() {
      return unexpected('db.get');
    },
    all() {
      return unexpected('db.all');
    },
    run() {
      return unexpected('db.run');
    },
    tx() {
      return unexpected('db.tx');
    },
    close() {
      unexpected('db.close');
    },
  };
  const model: Model = {
    get name() {
      return unexpected('model.name');
    },
    get endpointHost() {
      return unexpected('model.endpointHost');
    },
    get blocked() {
      return unexpected('model.blocked');
    },
    async decide() {
      return unexpected('model.decide');
    },
  };
  const movement: MovementDecisionProvider = {
    async decide() {
      return unexpected('movement.decide');
    },
    status() {
      return unexpected('movement.status');
    },
  };
  const deps: Parameters<typeof createPipeline>[0] = {
    db,
    model,
    modelMaxAttempts,
    movement,
    now() {
      return unexpected('now');
    },
    async sleep() {
      unexpected('sleep');
    },
    oplog() {
      unexpected('oplog');
    },
  };
  return { deps, effects };
}

function fixedInvalid(error: unknown): boolean {
  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'invalid');
  assert.equal(error.message, 'Invalid pipeline modelMaxAttempts');
  return true;
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

for (const policy of invalidPolicies) {
  test(`A1 direct construction invalid ${policy.label}: fixed synchronous error before every dependency effect`, () => {
    const { deps, effects } = inertDependencies(1);
    assert.ok(Reflect.set(deps, 'modelMaxAttempts', policy.value));
    assert.throws(() => createPipeline(deps), fixedInvalid);
    assert.deepEqual(effects, []);
  });
}

test('A1 direct construction missing policy rejects before reading any other dependency', () => {
  const { deps, effects } = inertDependencies(2);
  assert.ok(Reflect.deleteProperty(deps, 'modelMaxAttempts'));
  for (const key of ['db', 'model', 'movement', 'now', 'sleep', 'oplog']) {
    Object.defineProperty(deps, key, {
      get() {
        effects.push(`dependency.${key}`);
        throw new Error('Dependency read before policy validation');
      },
    });
  }
  assert.throws(() => createPipeline(deps), fixedInvalid);
  assert.deepEqual(effects, []);
});

test('A1 direct construction captures invalid getter once without coercion', () => {
  const { deps, effects } = inertDependencies(1);
  const coercible = {
    valueOf() {
      effects.push('policy.valueOf');
      return 1;
    },
    toString() {
      effects.push('policy.toString');
      return '2';
    },
  };
  let reads = 0;
  Object.defineProperty(deps, 'modelMaxAttempts', {
    get() {
      reads++;
      return coercible;
    },
  });
  assert.throws(() => createPipeline(deps), fixedInvalid);
  assert.equal(reads, 1);
  assert.deepEqual(effects, []);
});

test('A1 direct construction preserves throwing getter exception identity and reads once', () => {
  const { deps, effects } = inertDependencies(2);
  const supplied = new Error('Synthetic getter exception');
  let reads = 0;
  Object.defineProperty(deps, 'modelMaxAttempts', {
    get() {
      reads++;
      throw supplied;
    },
  });
  assert.throws(
    () => createPipeline(deps),
    (error) => error === supplied,
  );
  assert.equal(reads, 1);
  assert.deepEqual(effects, []);
});

for (const value of [1, 2] satisfies ModelConfig['maxAttempts'][]) {
  test(`A1 direct construction legal${value} reads once without DB/provider/status/time/log effects`, () => {
    const { deps, effects } = inertDependencies(value);
    let reads = 0;
    Object.defineProperty(deps, 'modelMaxAttempts', {
      get() {
        reads++;
        return value;
      },
    });
    const pipeline = createPipeline(deps);
    assert.equal(typeof pipeline.processNext, 'function');
    assert.equal(reads, 1);
    assert.deepEqual(effects, []);
  });
}

async function emptyDependencies(value: ModelConfig['maxAttempts'], disabled = false) {
  const cfg = loadConfig({
    KANBAN_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
    CONNECTORS: '',
    MODEL_PROVIDER: disabled ? 'disabled' : 'scripted',
    MOVEMENT_PROVIDER: 'replay',
  });
  const db = openDb(':memory:');
  const effects: string[] = [];
  const now = () => new Date('2026-10-12T00:00:00.000Z');
  const sleep = async () => {
    effects.push('sleep');
  };
  const oplog = () => {
    effects.push('oplog');
  };
  try {
    const model = await createModel(cfg.model, { db, oplog, ...(disabled ? {} : { scriptLines: [] }) });
    const movement = await createMovementProvider(cfg.movement, {
      db,
      now,
      sleep,
      oplog,
      replayLines: [],
      http: {
        async post() {
          effects.push('movement.http');
          throw new Error('External network blocked in construction test');
        },
      },
    });
    const decide = model.decide;
    model.decide = async (input, signal) => {
      effects.push('model.decide');
      return decide(input, signal);
    };
    const movementDecide = movement.decide;
    movement.decide = async (request, signal) => {
      effects.push('movement.decide');
      return movementDecide(request, signal);
    };
    const deps: Parameters<typeof createPipeline>[0] = {
      db,
      model,
      modelMaxAttempts: value,
      movement,
      now,
      sleep,
      oplog,
    };
    assert.deepEqual(effects, []);
    return { deps, effects };
  } catch (error) {
    db.close();
    throw error;
  }
}

function observePolicy(deps: Parameters<typeof createPipeline>[0], value: ModelConfig['maxAttempts']) {
  let reads = 0;
  Object.defineProperty(deps, 'modelMaxAttempts', {
    configurable: true,
    get() {
      reads++;
      return value;
    },
  });
  return () => reads;
}

function forbidPolicyRead(deps: Parameters<typeof createPipeline>[0]) {
  Object.defineProperty(deps, 'modelMaxAttempts', {
    configurable: true,
    get() {
      throw new Error('Existing pipeline reread mutable policy');
    },
  });
}

async function operateOnEmptyPipeline(pipeline: Pipeline, db: Db) {
  assert.equal(db.get<{ n: number }>('SELECT count(*) AS n FROM message')?.n, 0);
  assert.equal(await pipeline.processNext(), null);
  assert.equal(await pipeline.drain(), 0);
  assert.equal(pipeline.status().pending, 0);
  assert.equal(db.get<{ n: number }>('SELECT count(*) AS n FROM decision')?.n, 0);
}

test('A1 direct construction actual disabled Model still rejects invalid policy unconditionally', async () => {
  const { deps, effects } = await emptyDependencies(1, true);
  try {
    assert.equal(deps.model.blocked, 'no_model');
    assert.ok(Reflect.set(deps, 'modelMaxAttempts', 3));
    assert.throws(() => createPipeline(deps), fixedInvalid);
    assert.deepEqual(effects, []);
  } finally {
    deps.db.close();
  }
});

for (const value of [1, 2] satisfies ModelConfig['maxAttempts'][]) {
  test(`A1 direct construction legal${value} mutation and empty actual-DB operations never reread policy`, async () => {
    const { deps, effects } = await emptyDependencies(value);
    let pipeline: Pipeline | undefined;
    try {
      const reads = observePolicy(deps, value);
      pipeline = createPipeline(deps);
      assert.equal(reads(), 1);
      Object.defineProperty(deps, 'modelMaxAttempts', { configurable: true, writable: true, value: 3 });
      await operateOnEmptyPipeline(pipeline, deps.db);
      forbidPolicyRead(deps);
      await operateOnEmptyPipeline(pipeline, deps.db);
      await pipeline.stop();
      assert.equal(reads(), 1);
      assert.deepEqual(effects, []);
    } finally {
      if (pipeline) await pipeline.stop();
      deps.db.close();
    }
  });
}

test('A1 direct construction fresh instance reads fresh legal policy after old empty instance stops', async () => {
  const { deps, effects } = await emptyDependencies(1);
  const pipelines: Pipeline[] = [];
  try {
    const oldReads = observePolicy(deps, 1);
    const old = createPipeline(deps);
    pipelines.push(old);
    forbidPolicyRead(deps);
    await operateOnEmptyPipeline(old, deps.db);
    await old.stop();
    const freshReads = observePolicy(deps, 2);
    const fresh = createPipeline(deps);
    pipelines.push(fresh);
    assert.notEqual(fresh, old);
    assert.equal(oldReads(), 1);
    assert.equal(freshReads(), 1);
    forbidPolicyRead(deps);
    await operateOnEmptyPipeline(fresh, deps.db);
    await fresh.stop();
    assert.equal(oldReads(), 1);
    assert.equal(freshReads(), 1);
    assert.deepEqual(effects, []);
  } finally {
    await Promise.all(pipelines.map((pipeline) => pipeline.stop()));
    deps.db.close();
  }
});

test('A1 direct construction concurrent cfg1/cfg2 instances share opaque Model but isolate policy reads', async () => {
  const first = await emptyDependencies(1);
  let second: Awaited<ReturnType<typeof emptyDependencies>> | undefined;
  const pipelines: Pipeline[] = [];
  try {
    second = await emptyDependencies(2);
    second.deps.model = first.deps.model;
    assert.equal(first.deps.model, second.deps.model);
    assert.notEqual(first.deps.db, second.deps.db);
    const firstReads = observePolicy(first.deps, 1);
    const secondReads = observePolicy(second.deps, 2);
    const a = createPipeline(first.deps);
    const b = createPipeline(second.deps);
    pipelines.push(a, b);
    assert.notEqual(a, b);
    forbidPolicyRead(first.deps);
    forbidPolicyRead(second.deps);
    await Promise.all([operateOnEmptyPipeline(a, first.deps.db), operateOnEmptyPipeline(b, second.deps.db)]);
    assert.equal(firstReads(), 1);
    assert.equal(secondReads(), 1);
    assert.deepEqual(first.effects, []);
    assert.deepEqual(second.effects, []);
  } finally {
    await Promise.all(pipelines.map((pipeline) => pipeline.stop()));
    first.deps.db.close();
    second?.deps.db.close();
  }
});

test('A1 direct construction uses the public reexport and pins required indexed type and first capture', () => {
  assert.equal(createPipeline, reexportedPipeline);
  const source = readFileSync(new URL('./spine.ts', import.meta.url), 'utf8');
  assert.match(source, /import type \{[^}]*\bModelConfig\b[^}]*\} from '\.\.\/contracts\/index\.ts';/);
  const start = source.indexOf('export function createPipeline(deps: {');
  const end = source.indexOf('  const ctx:', start);
  assert.ok(start >= 0 && end > start);
  assert.equal(
    source.slice(start, end),
    `export function createPipeline(deps: {
  db: Db;
  model: Model;
  modelMaxAttempts: ModelConfig['maxAttempts'];
  movement: MovementDecisionProvider;
  now(): Date;
  sleep(ms: number): Promise<void>;
  oplog: OpLog;
}): Pipeline {
  const modelMaxAttempts = deps.modelMaxAttempts;
  if (modelMaxAttempts !== 1 && modelMaxAttempts !== 2)
    throw new AppError('invalid', 'Invalid pipeline modelMaxAttempts');
  const { db, now, model, movement } = deps;
`,
  );
  assert.equal(source.split('deps.modelMaxAttempts').length - 1, 1);
});
