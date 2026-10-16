import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { ModelConfig, OpenAIResponseRequest } from '../contracts/index.ts';
import { ModelResponseError, ModelUnavailable, modelDecisionJsonSchema } from '../contracts/index.ts';
import { createMovementHttpPort, createOpenAIResponsesPort } from './provider-ports.ts';

const cfg: ModelConfig = {
  provider: 'openai',
  name: 'synthetic-model',
  apiKey: 'synthetic-key-marker',
  scriptPath: null,
  timeoutMs: 30000,
  maxOutputTokens: 4096,
  maxAttempts: 2,
};
function request(): OpenAIResponseRequest {
  return {
    model: 'synthetic-model',
    input: [
      { role: 'system', content: 'Fixed instruction' },
      { role: 'user', content: 'Third-party data: synthetic' },
    ],
    text: { format: { type: 'json_schema', name: 'kanban_decision', strict: true, schema: modelDecisionJsonSchema } },
    max_output_tokens: 4096,
    store: false,
  };
}
const options = () => ({ signal: new AbortController().signal, timeoutMs: 500, maxResponseBytes: 1048576 });

test('I1 R27.6/9 official SDK bridge captures strict Responses wire and omits ambient headers without construction calls', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const port = createOpenAIResponsesPort(cfg, async (url, init) => {
    calls.push({ url, init });
    return Response.json({ status: 'completed', output: [] });
  });
  assert.ok(port);
  assert.equal(calls.length, 0);
  await port.create(request(), options());
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url, 'https://api.openai.com/v1/responses');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.redirect, 'error');
  assert.equal(call.init.credentials, 'omit');
  assert.deepEqual(JSON.parse(String(call.init.body)), request());
  assert.deepEqual(Object.fromEntries(new Headers(call.init.headers)), {
    authorization: 'Bearer synthetic-key-marker',
    'content-type': 'application/json',
  });
  assert.ok(!String(call.init.body).includes(cfg.apiKey ?? '')); // key exists only in the designated authorization header
  for (const missing of [
    { ...cfg, apiKey: null },
    { ...cfg, name: null },
    { ...cfg, provider: null },
  ]) {
    assert.equal(
      createOpenAIResponsesPort(missing, async () => {
        throw new Error('must not send');
      }),
      undefined,
    );
  }
});

test('I1 R27.10 SDK retries are zero, statuses/errors are safe and size/token bounds refuse', async () => {
  for (const [status, code] of [
    [401, 'unauthorised'],
    [403, 'unauthorised'],
    [400, 'unsupported_schema'],
    [429, 'unavailable'],
    [503, 'unavailable'],
  ] as const) {
    let calls = 0;
    const port = createOpenAIResponsesPort(cfg, async () => {
      calls++;
      return Response.json({ error: { message: 'private-error-marker', type: 'synthetic' } }, { status });
    });
    assert.ok(port);
    await assert.rejects(
      port.create(request(), options()),
      (error) =>
        (error instanceof ModelResponseError || error instanceof ModelUnavailable) &&
        error.code === code &&
        !String(error).includes('private-error-marker'),
    );
    assert.equal(calls, 1);
  }
  let calls = 0;
  const port = createOpenAIResponsesPort(cfg, async () => {
    calls++;
    return new Response('x'.repeat(100));
  });
  assert.ok(port);
  await assert.rejects(port.create(request(), { ...options(), maxResponseBytes: 99 }), { code: 'context_limit' });
  const over = request();
  over.input[1] = { role: 'user', content: 'x'.repeat(1048576) };
  await assert.rejects(port.create(over, options()), { code: 'context_limit' });
  await assert.rejects(port.create({ ...request(), max_output_tokens: 16385 }, options()), { code: 'schema_invalid' });
  assert.equal(calls, 1);
});

test('I1 R27.6/8 bridges refuse redirects, wrong destinations and oversized movement before sending', async () => {
  let calls = 0;
  const send = async () => {
    calls++;
    return new Response(null, { status: 302, headers: { Location: 'https://other.invalid' } });
  };
  const port = createOpenAIResponsesPort(cfg, send);
  assert.ok(port);
  await assert.rejects(port.create(request(), options()), { code: 'forbidden' });
  assert.equal(calls, 1);
  const movement = createMovementHttpPort(send);
  const input = {
    url: 'https://api.typesafe.ai/v1/systemone',
    headers: { Authorization: 'Bearer synthetic', Ambient: 'must not forward' },
    body: '{}',
    signal: new AbortController().signal,
    timeoutMs: 100,
    redirect: 'error' as const,
    maxResponseBytes: 1048576,
  };
  for (const url of [
    'http://api.typesafe.ai/v1/systemone',
    'https://other.invalid/v1/systemone',
    'https://api.typesafe.ai/v1/other',
    'https://api.typesafe.ai:444/v1/systemone',
    'https://user@api.typesafe.ai/v1/systemone',
    'https://api.typesafe.ai/v1/systemone?x=1',
    'https://api.typesafe.ai/v1/systemone#fragment',
    'https://api.openai.com/v1/responses',
  ]) {
    await assert.rejects(movement.post({ ...input, url }), { code: 'forbidden' });
  }
  await assert.rejects(movement.post({ ...input, body: 'x'.repeat(262145) }), { code: 'context_limit' });
  assert.equal(calls, 1);
  await assert.rejects(movement.post(input), { code: 'forbidden' });
  assert.equal(calls, 2);
  const capture = createMovementHttpPort(async (url, init) => {
    assert.equal(url, input.url);
    assert.deepEqual(Object.fromEntries(new Headers(init.headers)), {
      authorization: 'Bearer synthetic',
      'content-type': 'application/json',
    });
    return new Response('synthetic-body');
  });
  assert.deepEqual(await capture.post(input), { status: 200, body: 'synthetic-body' });
});

test('I1 provider deadlines and cancellation finish even when injected transport ignores abort; late output is discarded', async () => {
  // Keep the test event loop live while AbortSignal.timeout uses its unref timer.
  const keepAlive = delay(150);
  const never = async () => new Promise<Response>(() => {});
  const port = createOpenAIResponsesPort(cfg, never);
  assert.ok(port);
  await assert.rejects(port.create(request(), { ...options(), timeoutMs: 5 }), { code: 'timeout' });
  const controller = new AbortController();
  const pending = port.create(request(), { ...options(), signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  const movement = createMovementHttpPort(never);
  await assert.rejects(
    movement.post({
      url: 'https://api.typesafe.ai/v1/systemone',
      headers: { Authorization: 'Bearer synthetic' },
      body: '{}',
      signal: new AbortController().signal,
      timeoutMs: 5,
      redirect: 'error',
      maxResponseBytes: 100,
    }),
    { name: 'TimeoutError' },
  );
  await keepAlive;
});

test('cloud SDK raw boundary rejects recursive and escaped duplicate keys, malformed JSON and excessive depth safely', async () => {
  for (const raw of [
    '{"status":"incomplete","status":"completed","output":[]}',
    '{"status":"completed","output":[{"type":"reasoning","summary":[],"summary":[]}]}',
    String.raw`{"status":"completed","output":[],"st\u0061tus":"completed"}`,
    '{"status":"completed","output":[],}',
    `${'['.repeat(102)}0${']'.repeat(102)}`,
  ]) {
    let calls = 0;
    const port = createOpenAIResponsesPort(cfg, async () => {
      calls++;
      return new Response(raw, { headers: { 'Content-Type': 'application/json' } });
    });
    assert.ok(port);
    await assert.rejects(
      port.create(request(), options()),
      (error) =>
        error instanceof ModelResponseError && error.code === 'schema_invalid' && error.message === 'schema_invalid',
    );
    assert.equal(calls, 1);
  }
  const value = { status: 'completed', output: [], metadata: { quote: '"key":"x","key":"y"', slash: '\\' } };
  const port = createOpenAIResponsesPort(cfg, async () => Response.json(value));
  assert.ok(port);
  assert.deepEqual(await port.create(request(), options()), value);
});

test('cloud movement transport admits only both exact canonical URLs and cancels gateway bodies and redirects', async () => {
  const gateway = 'https://ai-gateway.vercel.sh/typesafe/v1/systemone';
  const input = {
    url: gateway,
    headers: { Authorization: 'Bearer synthetic-gateway', Ambient: 'must-not-forward' },
    body: '{}',
    signal: new AbortController().signal,
    timeoutMs: 500,
    redirect: 'error' as const,
    maxResponseBytes: 1048576,
  };
  let calls = 0;
  const movement = createMovementHttpPort(async (url, init) => {
    calls++;
    assert.ok([gateway, 'https://api.typesafe.ai/v1/systemone'].includes(url));
    assert.deepEqual(Object.fromEntries(new Headers(init.headers)), {
      authorization: 'Bearer synthetic-gateway',
      'content-type': 'application/json',
    });
    return new Response('{}');
  });
  for (const url of [
    'http://ai-gateway.vercel.sh/typesafe/v1/systemone',
    'https://ai-gateway.vercel.sh/v1/systemone',
    `${gateway}/`,
    `${gateway}?x=1`,
    `${gateway}#x`,
    'https://ai-gateway.vercel.sh:443/typesafe/v1/systemone',
    'https://ai-gateway.vercel.sh:444/typesafe/v1/systemone',
    'https://user@ai-gateway.vercel.sh/typesafe/v1/systemone',
    'https://ai-gateway.vercel.sh.evil.invalid/typesafe/v1/systemone',
    'https://ai-gateway.vercel.sh/typesafe/v1/../v1/systemone',
  ])
    await assert.rejects(movement.post({ ...input, url }), { code: 'forbidden' });
  assert.equal(calls, 0);
  await movement.post(input);
  assert.equal(calls, 1);
  const redirected = createMovementHttpPort(async () => new Response(null, { status: 307 }));
  await assert.rejects(redirected.post(input), { code: 'forbidden' });
  let cancelled = false;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const controller = new AbortController();
  const held = createMovementHttpPort(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{'));
            entered();
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  const pending = held.post({ ...input, signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true);
});
