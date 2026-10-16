import assert from 'node:assert/strict';
import test from 'node:test';
import { cloudFixture, completed, decision, jsonResponse } from '../src/agent/cloud-testing.ts';
import { listReview } from '../src/agent/index.ts';
import { getBoard } from '../src/board/index.ts';

for (const attempts of [1, 2] as const)
  for (const order of [
    ['schema', 'transient'],
    ['transient', 'schema'],
    ['schema', 'success'],
    ['transient', 'success'],
  ] as const) {
    test(`cloud shared captured attempt budget ${attempts}: ${order.join('→')}`, async (t) => {
      const h = await cloudFixture(t, { attempts });
      let n = 0;
      h.handlers.general = async (input) => {
        h.config.model.maxAttempts = attempts === 1 ? 2 : 1;
        const outcome = order[n++] ?? 'success';
        if (outcome === 'schema') return jsonResponse(completed({ disposition: 'create' }));
        if (outcome === 'transient') return jsonResponse({ error: { message: 'EXTERNAL-SECRET-MUST-NOT-LOG' } }, 429);
        return jsonResponse(completed(decision(input)));
      };
      await h.deliver('one');
      const processed = await h.app.pipeline.processNext();
      assert.equal(h.calls.length, attempts);
      assert.deepEqual(h.sleeps, order[0] === 'transient' && attempts === 2 ? [1000] : []);
      if ((attempts === 1 && order[0] === 'transient') || (attempts === 2 && order[1] === 'transient')) {
        assert.equal(processed, null);
        assert.equal(h.app.pipeline.status().state, 'paused');
        assert.equal(h.app.pipeline.status().modelFailure, 'unavailable');
        assert.equal(listReview(h.ctx).length, 0);
        assert.equal(await h.app.pipeline.drain(), 0);
        assert.equal(h.calls.length, attempts);
      } else {
        assert.ok(processed);
        assert.equal(
          listReview(h.ctx)[0]?.kind,
          attempts === 2 && order[1] === 'success' ? 'new_card' : 'model_failed',
        );
      }
      assert.doesNotMatch(JSON.stringify(h.logs), /EXTERNAL-SECRET/);
    });
  }

test('cloud transient backoff is 30/60/120/240/300 seconds, cannot spin before due, success resets only the recovered message', async (t) => {
  const h = await cloudFixture(t, { attempts: 1 });
  h.handlers.general = async () => jsonResponse({}, 503);
  await h.deliver('one');
  for (const delay of [30000, 60000, 120000, 240000, 300000, 300000]) {
    const before = h.calls.length;
    assert.equal(await h.app.pipeline.processNext(), null);
    assert.equal(h.calls.length, before + 1);
    h.advance(delay - 1);
    assert.equal(await h.app.pipeline.processNext(), null);
    assert.equal(await h.app.pipeline.drain(), 0);
    assert.equal(h.calls.length, before + 1);
    h.advance(1);
  }
  h.handlers.general = async (input) => jsonResponse(completed(decision(input)));
  assert.ok(await h.app.pipeline.processNext());
  assert.equal(h.app.pipeline.status().modelFailure, null);
  h.handlers.general = async () => jsonResponse({}, 503);
  await h.deliver('two');
  assert.equal(await h.app.pipeline.processNext(), null);
  h.advance(29999);
  const before = h.calls.length;
  assert.equal(await h.app.pipeline.processNext(), null);
  assert.equal(h.calls.length, before);
  h.advance(1);
  assert.equal(await h.app.pipeline.processNext(), null);
  assert.equal(h.calls.length, before + 1);
});

for (const status of [400, 401, 403])
  test(`cloud HTTP ${status} latches a safe blocked model without retry or raw error disclosure`, async (t) => {
    const h = await cloudFixture(t);
    h.handlers.general = async () => jsonResponse({ error: { message: 'NEVER-LOG-PROVIDER-KEY-OR-REFUSAL' } }, status);
    await h.deliver('one');
    assert.ok(await h.app.pipeline.processNext());
    assert.equal(h.calls.length, 1);
    assert.equal(h.app.pipeline.status().reason, status === 400 ? 'model_configuration_invalid' : 'model_unauthorised');
    assert.equal(listReview(h.ctx)[0]?.canAccept, false);
    await h.deliver('two');
    assert.equal(await h.app.pipeline.processNext(), null);
    assert.equal(h.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(h.db.all('SELECT * FROM decision')), /NEVER-LOG/);
    assert.doesNotMatch(JSON.stringify(h.logs), /NEVER-LOG/);
  });

for (const kind of [
  'refusal',
  'incomplete',
  'duplicate',
  'tool',
  'two-texts',
  'invalid-json',
  'invalid-ids',
  'reasoning',
  'forged-reasoning',
] as const)
  test(`cloud actual SDK envelope ${kind} fails closed or accepts only documented non-action metadata`, async (t) => {
    const h = await cloudFixture(t);
    h.handlers.general = async (input) => {
      const value = completed(decision(input)) as { status: string; output: unknown[] };
      if (kind === 'refusal')
        value.output = [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'refusal', refusal: 'PRIVATE-REFUSAL' }],
          },
        ];
      if (kind === 'incomplete') value.status = 'incomplete';
      if (kind === 'duplicate' || kind === 'invalid-json')
        value.output = [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: kind === 'duplicate' ? '{"confidence":1,"confidence":0}' : '{bad' }],
          },
        ];
      if (kind === 'tool') value.output.unshift({ type: 'function_call', name: 'mutate_everything', arguments: '{}' });
      if (kind === 'two-texts') value.output.push(value.output[0]);
      if (kind === 'reasoning') value.output.unshift({ type: 'reasoning', id: 'rs_test', summary: [] });
      if (kind === 'forged-reasoning')
        value.output.unshift({ type: 'reasoning', id: 'rs_test', summary: [], action: 'delete' });
      if (kind === 'invalid-ids') return jsonResponse(completed(decision(input, { laneId: 999999 })));
      return jsonResponse(value);
    };
    await h.deliver('one');
    await h.app.pipeline.drain();
    assert.equal(h.calls.length, ['refusal', 'invalid-ids', 'reasoning'].includes(kind) ? 1 : 2);
    assert.equal(listReview(h.ctx)[0]?.kind, kind === 'reasoning' ? 'new_card' : 'model_failed');
    assert.equal(getBoard(h.ctx).lanes[0]?.cards.length, 0);
    assert.doesNotMatch(JSON.stringify(h.db.all('SELECT * FROM decision')), /PRIVATE-REFUSAL|mutate_everything/);
  });

for (const missing of ['general', 'movement'] as const)
  test(`cloud missing ${missing} config keeps App/Host/human paths working without requests to that provider`, async (t) => {
    const h = await cloudFixture(t, {
      missingModel: missing === 'general',
      missingMovement: missing === 'movement',
      otherLane: true,
    });
    await h.deliver('one');
    await h.app.pipeline.drain();
    assert.equal((await h.get('/board')).status, 200);
    assert.equal((await h.get('/review')).status, 200);
    assert.equal(h.calls.filter((c) => c.url.includes(missing === 'general' ? 'openai' : 'typesafe')).length, 0);
    if (missing === 'general') assert.equal(h.app.pipeline.status().reason, 'model_config_missing');
    else {
      assert.equal(h.app.pipeline.status().movement.reason, 'missing_config');
      assert.ok(listReview(h.ctx).some((r) => r.kind === 'new_card'));
    }
  });

for (const mode of ['general-excerpt', 'movement-excerpt', 'response'] as const)
  test(`cloud ${mode} context caps fail safely through production ports without partial mutations`, async (t) => {
    const h = await cloudFixture(t, {
      otherLane: mode === 'movement-excerpt',
      text: 'x'.repeat(mode === 'general-excerpt' ? 16385 : mode === 'movement-excerpt' ? 4097 : 10),
    });
    if (mode === 'response') h.handlers.general = async () => jsonResponse({ oversized: 'x'.repeat(1048577) });
    await h.deliver('one');
    await h.app.pipeline.drain();
    assert.equal(h.calls.length, mode === 'general-excerpt' ? 0 : 1);
    const failure = listReview(h.ctx).find((r) => r.kind === 'model_failed');
    assert.ok(failure);
    assert.equal(failure.reason, 'context_limit');
    if (mode === 'movement-excerpt') assert.equal(h.app.pipeline.status().movement.reason, 'context_limit');
    assert.equal(failure.canAccept, false);
    assert.equal(getBoard(h.ctx).lanes[0]?.cards.length, 0);
  });

for (const provider of ['general', 'movement'] as const)
  test(`cloud actual ${provider} production timeout aborts held HTTP, respects its attempt budget, and reports timeout`, async (t) => {
    const h = await cloudFixture(t, {
      attempts: 1,
      movementAttempts: 2,
      otherLane: provider === 'movement',
      timeoutMs: 10,
    });
    const held = Promise.withResolvers<Response>();
    if (provider === 'general') h.handlers.general = async () => held.promise;
    else h.handlers.movement = async () => held.promise;
    // AbortSignal.timeout is unref'ed; this finite synthetic handle only keeps the
    // test process alive until the real production timeout has fired.
    const keeper = setTimeout(() => held.resolve(jsonResponse({})), 500);
    try {
      await h.deliver('one');
      await h.app.pipeline.processNext();
      if (provider === 'general') {
        assert.equal(h.app.pipeline.status().modelFailure, 'timeout');
        assert.equal(h.calls.length, 1);
        assert.equal(h.app.pipeline.status().state, 'paused');
      } else {
        assert.equal(h.app.pipeline.status().movement.reason, 'timeout');
        assert.equal(h.calls.filter((c) => c.url.includes('typesafe')).length, 2);
        assert.deepEqual(h.sleeps, [1000]);
      }
      assert.equal(h.calls.at(-1)?.init.signal?.aborted, true);
    } finally {
      clearTimeout(keeper);
      held.reject(new Error('late ignored timeout outcome'));
    }
  });

test('cloud two actual App instances have independent captured budgets and blocked state; restart captures the new immutable config', async (t) => {
  const a = await cloudFixture(t, { attempts: 1 });
  const b = await cloudFixture(t, { attempts: 2 });
  a.handlers.general = async () => jsonResponse({}, 503);
  let calls = 0;
  b.handlers.general = async (input) =>
    ++calls === 1 ? jsonResponse(completed({})) : jsonResponse(completed(decision(input)));
  await a.deliver('one');
  await b.deliver('one');
  await a.app.pipeline.processNext();
  await b.app.pipeline.processNext();
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 2);
  assert.equal(a.app.pipeline.status().state, 'paused');
  assert.equal(listReview(b.ctx)[0]?.kind, 'new_card');
  a.config.model.maxAttempts = 2;
  await a.restart();
  await a.app.pipeline.processNext();
  assert.equal(a.calls.length, 3);
  assert.deepEqual(a.sleeps, [1000]);
});

test('cloud absent configured model ID blocks construction safely with zero requests and no guessed model', async (t) => {
  const h = await cloudFixture(t, { missingModelId: true });
  await h.deliver('one');
  await h.app.pipeline.drain();
  assert.equal(h.app.pipeline.status().reason, 'model_config_missing');
  assert.equal(h.calls.length, 0);
  assert.equal((await h.get('/board')).status, 200);
});
