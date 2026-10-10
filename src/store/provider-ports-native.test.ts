import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// A separate process isolates the builtin HTTPS seam and detects asynchronous process death.
// The actual default bridge constructs both Responses; no preconstructed Response is injected.
const probe = `
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
const scenario = process.argv[1];
const counts = { calls: 0, requestDestroyed: 0, responseDestroyed: 0 };
const keepAlive = setInterval(() => {}, 1000);
process.once('uncaughtException', (error) => {
  console.log(JSON.stringify({ outcome: 'uncaughtException', name: error.name, message: error.message, counts }));
  process.exit(7);
});
process.once('unhandledRejection', (error) => {
  console.log(JSON.stringify({ outcome: 'unhandledRejection', message: String(error), counts }));
  process.exit(8);
});
https.request = (url, options, onResponse) => {
  counts.calls++;
  if (url !== 'https://api.typesafe.ai/v1/systemone' || options.method !== 'POST') throw new Error('wrong destination');
  const req = new EventEmitter();
  const res = new EventEmitter();
  req.destroy = () => { counts.requestDestroyed++; };
  Object.assign(res, {
    headers: scenario === 'header-error' ? { 'bad\\nheader': 'private-header-marker' } : {},
    statusCode: /^20[45]$|^304$/.test(scenario) ? Number(scenario) : scenario === 'construction-error' ? 700 : 200,
    pause() { if (scenario === 'pause-error') throw new Error('private-stream-marker'); },
    resume() { if (scenario === 'resume-error') throw new Error('private-stream-marker'); },
    destroy() { counts.responseDestroyed++; },
  });
  options.signal.addEventListener('abort', () => req.emit('error', new Error('synthetic abort')), { once: true });
  req.end = () => setImmediate(() => {
    onResponse(res);
    setImmediate(() => {
    if (scenario === 'timeout') return;
    if (scenario === 'cancel') { setImmediate(() => controller.abort()); return; }
    if (scenario === 'stream-error') res.emit('error', new Error('private-stream-marker'));
    else if (!/^20[45]$|^304$/.test(scenario)) res.emit('data', Buffer.from(scenario === 'overflow' ? 'abcdef' : 'abc'));
    if (scenario !== 'overflow') res.emit('end');
    // Late events after completion/cancel/failure must never reach a closed controller.
    setImmediate(() => {
      res.emit('data', Buffer.from('late'));
      res.emit('end');
      if (res.listenerCount('error')) res.emit('error', new Error('private-late-marker'));
    });
    });
  });
  return req;
};
syncBuiltinESMExports();
const { createMovementHttpPort } = await import('./src/store/provider-ports.ts');
const controller = new AbortController();
let result;
try {
  result = { outcome: 'resolved', value: await createMovementHttpPort().post({
    url: 'https://api.typesafe.ai/v1/systemone',
    headers: { Authorization: 'Bearer synthetic' }, body: '{}',
    signal: controller.signal, timeoutMs: scenario === 'timeout' ? 30 : 500,
    maxResponseBytes: scenario === 'overflow' ? 5 : 100, redirect: 'error',
  }) };
} catch (error) {
  result = { outcome: 'rejected', name: error.name, message: error.message, code: error.code ?? null };
}
await nextTurn();
await nextTurn();
clearInterval(keepAlive);
console.log(JSON.stringify({ ...result, counts }));
`;

function run(scenario: string) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', probe, scenario], {
    cwd: new URL('../../', import.meta.url),
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, `${scenario}: ${child.stdout}\n${child.stderr}`);
  return JSON.parse(child.stdout) as {
    outcome: string;
    value?: { status: number; body: string };
    name?: string;
    message?: string;
    code?: string | number | null;
    counts: { calls: number; requestDestroyed: number; responseDestroyed: number };
  };
}

for (const status of [204, 205, 304]) {
  test(`I1-F1 native HTTPS ${status} uses a null body without process death and releases resources`, () => {
    const result = run(String(status));
    if (status === 304) {
      assert.equal(result.outcome, 'rejected');
      assert.equal(result.code, 'forbidden');
      assert.equal(result.message, 'Provider redirect blocked');
    } else {
      assert.equal(result.outcome, 'resolved');
      assert.deepEqual(result.value, { status, body: '' });
    }
    assert.deepEqual(result.counts, { calls: 1, requestDestroyed: 1, responseDestroyed: 1 });
  });
}

for (const scenario of ['construction-error', 'header-error', 'pause-error', 'resume-error', 'stream-error']) {
  test(`I1-F1 native HTTPS ${scenario} rejects safely and destroys request/response`, () => {
    const result = run(scenario);
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.message, 'unavailable');
    assert.deepEqual(result.counts, { calls: 1, requestDestroyed: 1, responseDestroyed: 1 });
  });
}

for (const [scenario, name, code] of [
  ['overflow', 'ModelResponseError', 'context_limit'],
  ['timeout', 'TimeoutError', 23],
  ['cancel', 'AbortError', 20],
] as const) {
  test(`I1-F1 native HTTPS ${scenario} remains bounded and releases resources`, () => {
    const result = run(scenario);
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.name, name);
    assert.equal(result.code, code);
    assert.deepEqual(result.counts, { calls: 1, requestDestroyed: 1, responseDestroyed: 1 });
  });
}

test('I1-F1 native HTTPS normal body survives late events after end', () => {
  const result = run('normal');
  assert.equal(result.outcome, 'resolved');
  assert.deepEqual(result.value, { status: 200, body: 'abc' });
  assert.equal(result.counts.calls, 1);
});
