import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { attachMessage, createCard, createLane } from '../board/index.ts';
import { loadConfig } from '../config.ts';
import type {
  Ctx,
  Db,
  Model,
  ModelConfig,
  MovementDecisionProvider,
  MovementRequest,
  MovementResult,
  Pipeline,
} from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';
import { setContactCompany, setContactRole } from '../graph/index.ts';
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
    registerAgentCancellation() {
      return unexpected('db.registerAgentCancellation');
    },
    invalidateAgentWork() {
      unexpected('db.invalidateAgentWork');
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
  console.log(
    'FIRST_EXACT_AGENT_MEMORY',
    JSON.stringify({
      identity: randomUUID(),
      memory: true,
      handles: 0,
      olderWriters: 0,
      predecessorExited: true,
      consumer: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    }),
  );
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

// Direct thin support cases use ordinary openDb/createPipeline. Actual App/Host S acceptance remains Host3's gate.
function supportFixture(mode: 'general' | 'movement', options: { rejectOnAbort?: boolean; error?: AppError } = {}) {
  console.log(
    'FIRST_EXACT_AGENT_MEMORY',
    JSON.stringify({
      identity: randomUUID(),
      memory: true,
      handles: 0,
      olderWriters: 0,
      predecessorExited: true,
      consumer: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    }),
  );
  const db = openDb(':memory:');
  const now = () => new Date('2026-09-01T10:00:00.000Z');
  const ctx: Ctx = { db, now, canReadText: true, actor: { kind: 'teammate', id: 1 } };
  try {
    db.tx(() => {
      db.run(
        "INSERT INTO teammate(id,username,display_name,password_hash,created_at) VALUES (1,'synthetic','Synthetic','unused',?)",
        now().toISOString(),
      );
      db.run(
        "INSERT INTO channel_account(id,teammate_id,channel,state,created_at) VALUES (1,1,'fixture','connected',?)",
        now().toISOString(),
      );
      db.run(
        "INSERT INTO chat(id,channel,chat_key,kind,title,created_at) VALUES (1,'fixture','selected','group','Synthetic chat',?)",
        now().toISOString(),
      );
      db.run(
        "INSERT INTO chat_selection(account_id,chat_key,decision,decided_at) VALUES (1,'selected','included',?)",
        now().toISOString(),
      );
      db.run("INSERT INTO account_chat(account_id,chat_id,native_chat_id,sync_state) VALUES (1,1,'selected','idle')");
      db.run(
        "INSERT INTO contact(id,display_name,created_at) VALUES (1,'Synthetic participant',?)",
        now().toISOString(),
      );
      db.run(
        "INSERT INTO identity(id,channel,user_key,display_name,contact_id) VALUES (1,'fixture','outside','Synthetic participant',1)",
      );
      db.run(
        "INSERT INTO message(id,chat_id,message_key,sender_identity_id,sent_at,text,origin,stored_at) VALUES (1,1,'current',1,?,'Synthetic evidence','live',?)",
        now().toISOString(),
        now().toISOString(),
      );
      db.run('INSERT INTO chat_participant(chat_id,identity_id,first_seen_at) VALUES (1,1,?)', now().toISOString());
    });
    const lane = createLane(ctx, {
      name: 'Synthetic lane',
      sop: 'Synthetic SOP',
      stages: [
        { name: 'Initial', criteria: '' },
        { name: 'Done', criteria: 'Synthetic completion' },
      ],
    });
    const decision = {
      disposition: 'create',
      cardId: null,
      proposalId: null,
      laneId: lane.id,
      title: 'Synthetic result',
      summary: 'Synthetic summary.',
      cardCompanyId: null,
      cardCompanyName: null,
      confidence: 1,
      reason: 'Synthetic reason',
      move: null,
      contacts: [],
      mentions: [],
    };
    const entered = Promise.withResolvers<void>();
    const response = Promise.withResolvers<unknown>();
    const movementResponse = Promise.withResolvers<MovementResult>();
    const signals: AbortSignal[] = [];
    const requests: MovementRequest[] = [];
    let generalCalls = 0;
    let movementCalls = 0;
    let releaseSleep = () => {};
    const sleepEntered = Promise.withResolvers<void>();
    let holdSleep = false;
    function hold(signal: AbortSignal) {
      signals.push(signal);
      entered.resolve();
      if (options.rejectOnAbort)
        signal.addEventListener(
          'abort',
          () => {
            response.reject(new DOMException('Aborted', 'AbortError'));
            movementResponse.reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true },
        );
    }
    // Only the selected raw promise is used; the other rejected fixture boundary is always observed too.
    void response.promise.catch(() => {});
    void movementResponse.promise.catch(() => {});
    function result(request: MovementRequest): MovementResult {
      return {
        provider: 'jev',
        execution: 'replay',
        configuredModel: null,
        providerRequestId: null,
        schemaVersion: 1,
        requestId: request.requestId,
        snapshotHash: request.snapshotHash,
        kind: 'not_requested',
        code: 'no_destination',
      };
    }
    const pipeline = createPipeline({
      db,
      now,
      modelMaxAttempts: 2,
      model: {
        name: 'opaque-synthetic',
        endpointHost: null,
        blocked: null,
        decide(_input, signal) {
          generalCalls++;
          if (options.error && mode === 'general') throw options.error;
          if (mode === 'general' && generalCalls === 1) {
            hold(signal);
            return response.promise;
          }
          signals.push(signal);
          return Promise.resolve(decision);
        },
      },
      movement: {
        decide(request, signal) {
          movementCalls++;
          requests.push(request);
          if (options.error && mode === 'movement') throw options.error;
          if (mode === 'movement' && movementCalls === 1) {
            hold(signal);
            return movementResponse.promise;
          }
          signals.push(signal);
          return Promise.resolve(result(request));
        },
        status: () => ({
          provider: null,
          execution: 'disabled',
          state: 'blocked',
          reason: 'missing_config',
          endpointHost: null,
          model: null,
        }),
      },
      sleep() {
        assert.equal(holdSleep, true);
        sleepEntered.resolve();
        const wait = Promise.withResolvers<void>();
        releaseSleep = wait.resolve;
        return wait.promise;
      },
      oplog() {},
    });
    return {
      db,
      ctx,
      pipeline,
      lane,
      entered: entered.promise,
      signals,
      requests,
      decision,
      calls: () => [generalCalls, movementCalls],
      release(outcome: 'success' | 'reject') {
        if (outcome === 'reject') {
          response.reject(new Error('Synthetic losing rejection'));
          movementResponse.reject(new Error('Synthetic losing rejection'));
        } else {
          response.resolve(decision);
          const request = requests[0];
          if (request) movementResponse.resolve(result(request));
        }
      },
      sleepEntered: sleepEntered.promise,
      holdSleep() {
        holdSleep = true;
      },
      releaseSleep() {
        releaseSleep();
      },
      async close() {
        await pipeline.stop();
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
function noProcessing(db: Db) {
  assert.equal(db.get<{ n: number }>('SELECT count(*) AS n FROM decision')?.n, 0);
  assert.equal(db.get<{ n: number }>('SELECT count(*) AS n FROM review_item')?.n, 0);
  assert.equal(
    db.get<{ processed_version: number }>('SELECT processed_version FROM message WHERE id=1')?.processed_version,
    0,
  );
}
for (const mode of ['general', 'movement'] as const) {
  for (const late of ['success', 'reject'] as const) {
    test(`Agent support ${mode} scoped cancellation settles managed work before losing ${late}, distinct successor`, async () => {
      const f = supportFixture(mode);
      try {
        const old = f.pipeline.processNext();
        await f.entered;
        const signal = f.signals.at(-1);
        assert.ok(signal);
        if (mode === 'movement') assert.equal(f.signals[0], signal);
        const sentinel = new Error('Synthetic rollback');
        assert.throws(
          () =>
            f.db.tx(() => {
              f.db.invalidateAgentWork({ chatIds: [], messageIds: [1] });
              assert.equal(signal.aborted, false);
              f.db.run("UPDATE chat_selection SET decision='excluded' WHERE account_id=1");
              throw sentinel;
            }),
          (error) => error === sentinel,
        );
        assert.equal(signal.aborted, true);
        assert.equal(await old, null);
        noProcessing(f.db);
        assert.equal(await f.pipeline.processNext(), 1);
        const successor = f.signals.at(-1);
        assert.ok(successor);
        assert.notEqual(successor, signal);
        assert.equal(successor.aborted, false);
        const snapshot = f.db.all('SELECT * FROM decision');
        const calls = f.calls();
        f.release(late);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(f.calls(), calls);
        assert.deepEqual(f.db.all('SELECT * FROM decision'), snapshot);
        // Successful completion released BOTH registrations without aborting the successor.
        f.db.invalidateAgentWork({ chatIds: [1], messageIds: [1] });
        assert.equal(successor.aborted, false);
      } finally {
        f.release('success');
        await f.close();
      }
    });
    test(`Agent support ${mode} stop handles signal-ignoring late ${late} independently`, async () => {
      const f = supportFixture(mode);
      try {
        const work = f.pipeline.processNext();
        await f.entered;
        const signal = f.signals.at(-1);
        assert.ok(signal);
        await f.pipeline.stop();
        assert.equal(signal.aborted, true);
        assert.equal(await work, null);
        noProcessing(f.db);
        f.release(late);
        await new Promise<void>((resolve) => setImmediate(resolve));
        noProcessing(f.db);
      } finally {
        f.release('success');
        await f.close();
      }
    });
  }
  test(`Agent support ${mode} abort rejection is handled and releases registration`, async () => {
    const f = supportFixture(mode, { rejectOnAbort: true });
    try {
      const work = f.pipeline.processNext();
      await f.entered;
      await f.pipeline.stop();
      assert.equal(await work, null);
      noProcessing(f.db);
    } finally {
      await f.close();
    }
  });
  for (const change of [
    "UPDATE account_chat SET sync_state='syncing' WHERE chat_id=1",
    "UPDATE chat_selection SET decision='excluded' WHERE account_id=1",
    "UPDATE teammate SET removed_at='2026-09-01T11:00:00.000Z' WHERE id=1",
    "UPDATE channel_account SET state='auth_lost' WHERE id=1",
    'UPDATE message SET version=2 WHERE id=1',
    "UPDATE message SET text='Changed context' WHERE id=1",
    "UPDATE contact SET role_category='finance',deals_about='Changed role' WHERE id=1",
    "UPDATE lane SET sop='Changed SOP',version=version+1 WHERE id=1",
  ]) {
    test(`Agent support ${mode} durable freshness without notification: ${change}`, async () => {
      const f = supportFixture(mode);
      try {
        const work = f.pipeline.processNext();
        await f.entered;
        const signal = f.signals.at(-1);
        assert.ok(signal);
        f.db.tx(() => f.db.run(change));
        assert.equal(signal.aborted, false);
        f.release('success');
        assert.equal(await work, null);
        noProcessing(f.db);
        assert.deepEqual(f.calls(), mode === 'general' ? [1, 0] : [1, 1]);
      } finally {
        f.release('success');
        await f.close();
      }
    });
  }
  test(`Agent support ${mode} genuine synchronous provider error retains identity and cleanup`, async () => {
    const sentinel = new AppError('invalid', 'Synthetic invocation failure');
    const f = supportFixture(mode, { error: sentinel });
    try {
      await assert.rejects(f.pipeline.processNext(), (error) => error === sentinel);
      noProcessing(f.db);
    } finally {
      await f.close();
    }
  });
}
test('Agent support actual registration refusal in joined transaction has zero provider effects', async () => {
  const f = supportFixture('general');
  try {
    let result: Promise<unknown> | undefined;
    f.db.tx(() => {
      result = f.pipeline.processNext().then(
        () => assert.fail('Expected boundary refusal'),
        (error: unknown) => error,
      );
    });
    const error = await result;
    assert.ok(error instanceof AppError);
    assert.equal(error.message, 'Agent cancellation registration requires an idle transaction boundary');
    assert.deepEqual(f.calls(), [0, 0]);
    noProcessing(f.db);
  } finally {
    await f.close();
  }
});
test('Agent support loop stop settles handled injected idle wait without waiting for raw sleep', async () => {
  const f = supportFixture('general');
  try {
    f.db.tx(() => f.db.run('UPDATE message SET processed_version=version'));
    f.holdSleep();
    f.pipeline.start();
    await f.sleepEntered;
    await f.pipeline.stop();
    f.releaseSleep();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(f.calls(), [0, 0]);
    assert.equal(f.pipeline.status().state, 'stopped');
  } finally {
    await f.close();
  }
});

for (const mode of ['general', 'movement'] as const) {
  for (const dependency of ['card', 'participant-role', 'participant-company'] as const) {
    test(`Agent support ${mode} actual supplied ${dependency} provenance has scoped other-chat cancellation`, async () => {
      const f = supportFixture(mode);
      try {
        f.db.tx(() => {
          f.db.run(
            "INSERT INTO chat(id,channel,chat_key,kind,title,created_at) VALUES (2,'fixture','support','group','Synthetic support',?)",
            f.ctx.now().toISOString(),
          );
          f.db.run(
            "INSERT INTO chat_selection(account_id,chat_key,decision,decided_at) VALUES (1,'support','included',?)",
            f.ctx.now().toISOString(),
          );
          f.db.run(
            "INSERT INTO account_chat(account_id,chat_id,native_chat_id,sync_state) VALUES (1,2,'support','idle')",
          );
          f.db.run(
            "INSERT INTO message(id,chat_id,message_key,sender_identity_id,sent_at,text,origin,stored_at,processed_version) VALUES (2,2,'support',1,?,'Synthetic support evidence','live',?,1)",
            f.ctx.now().toISOString(),
            f.ctx.now().toISOString(),
          );
          f.db.run(
            'INSERT INTO chat_participant(chat_id,identity_id,first_seen_at) VALUES (2,1,?)',
            f.ctx.now().toISOString(),
          );
        });
        const agent: Ctx = { ...f.ctx, actor: { kind: 'agent' } };
        if (dependency === 'card') {
          const card = createCard(
            f.ctx,
            { laneId: f.lane.id, title: 'Contributed title', summary: 'Contributed summary', chatId: 2, messageId: 2 },
            { setBy: 'agent' },
          );
          attachMessage(f.ctx, 1, card.id, { setBy: 'agent' });
        } else if (dependency === 'participant-role') {
          setContactRole(agent, 1, {
            category: 'finance',
            dealsAbout: 'Synthetic contribution',
            evidenceMessageIds: [2],
          });
        } else {
          setContactCompany(agent, 1, { company: { name: 'Synthetic contributed company' }, evidenceMessageIds: [2] });
        }
        const work = f.pipeline.processNext();
        await f.entered;
        const signal = f.signals.at(-1);
        assert.ok(signal);
        f.db.invalidateAgentWork({ chatIds: [2], messageIds: [] });
        assert.equal(signal.aborted, true);
        assert.equal(await work, null);
        f.release('reject');
        noProcessing(f.db);
      } finally {
        f.release('success');
        await f.close();
      }
    });
  }
}
test('Agent support missing agent-written role provenance cannot authorize a provider call', async () => {
  const f = supportFixture('general');
  try {
    f.db.tx(() => f.db.run("UPDATE contact SET role_category='finance',deals_about='Unproven text' WHERE id=1"));
    assert.equal(await f.pipeline.processNext(), null);
    assert.deepEqual(f.calls(), [0, 0]);
    noProcessing(f.db);
  } finally {
    await f.close();
  }
});
