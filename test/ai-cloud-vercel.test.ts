import assert from 'node:assert/strict';
import test from 'node:test';
import type { WireRequest } from '../src/agent/cloud-testing.ts';
import { cloudFixture, completed, decision, jevAnswer, jsonResponse } from '../src/agent/cloud-testing.ts';
import { createMovementProvider, listReview } from '../src/agent/index.ts';
import { getBoard } from '../src/board/index.ts';
import { history } from '../src/log/index.ts';
import { createMovementHttpPort } from '../src/store/provider-ports.ts';

function gatewayAnswer(body: WireRequest, selected = 'stay') {
  return {
    ...(jevAnswer(body, selected) as {
      answers: Record<string, { probabilities: Record<string, number>; confidence: number }>;
      usage?: { input_tokens: number; output_tokens: number };
    }),
    model: 'typesafe-ai/jev',
    provider_metadata: {
      gateway: {
        routing: {
          originalModelId: 'typesafe-ai/jev',
          resolvedProvider: 'typesafe-ai',
          canonicalSlug: 'typesafe-ai/jev',
          finalProvider: 'typesafe-ai',
        },
        cost: '0.00001155',
        marketCost: '0.00001155',
        surchargeCost: '0',
        gatewayCost: '0.00001155',
        generationId: 'gen_synthetic_metadata_marker',
      },
    },
  };
}

for (const threshold of [1, 0])
  test(`cloud Vercel canonical production transport → N+2 Jev → HTTP human approval → actual movement at threshold ${threshold}`, async (t) => {
    const h = await cloudFixture(t, { gateway: true, otherLane: true, threshold });
    h.handlers.movement = async (body) => {
      assert.equal(body.model, 'typesafe-ai/jev');
      assert.deepEqual(Object.keys(body).sort(), ['model', 'questions', 'state']);
      const state = JSON.parse(body.state);
      assert.equal(Object.keys(body.questions).length, state.options.length + 2);
      return jsonResponse(gatewayAnswer(body, state.options[1].id));
    };
    await h.deliver('one');
    await h.app.pipeline.drain();
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1]?.url, 'https://ai-gateway.vercel.sh/typesafe/v1/systemone');
    assert.equal(new Headers(h.calls[1]?.init.headers).get('Authorization'), 'Bearer synthetic-gateway-secret');
    assert.doesNotMatch(String(h.calls[1]?.init.body), /synthetic-.*-secret/);
    assert.equal(h.app.pipeline.status().movement.endpointHost, 'ai-gateway.vercel.sh');
    assert.equal(h.app.pipeline.status().movement.provider, 'jev');
    const result = JSON.parse(h.db.get<{ result: string }>('SELECT result FROM movement_decision')?.result ?? '{}');
    assert.equal(result.kind, 'answered');
    assert.equal(result.configuredModel, 'typesafe-ai/jev');
    assert.equal(result.resolvedModel, null, 'primary alias echo cannot establish an underlying model version');
    assert.equal(result.providerRequestId, null);
    assert.deepEqual(result.usage, { inputTokens: 300, outputTokens: 30 });
    assert.doesNotMatch(
      JSON.stringify(h.db.all('SELECT * FROM movement_decision')),
      /gen_synthetic_metadata_marker|gatewayCost/,
    );
    const review = listReview(h.ctx).find((r) => r.why === 'cross_lane');
    assert.ok(review?.canAccept);
    assert.equal(getBoard(h.ctx).lanes[1]?.cards.length, 0);
    assert.equal((await h.get('/review')).status, 200);
    const detail = await h.get(`/review/${review.id}`);
    assert.equal(detail.status, 200);
    assert.match(await detail.text(), /Accept proposed action/);
    assert.equal((await h.post(`/review/${review.id}/accept`)).status, 303);
    assert.equal(getBoard(h.ctx).lanes[1]?.cards[0]?.stageId, h.other?.stages[1]?.id);
    assert.equal(history(h.ctx, { action: 'review.accept' })[0]?.actor.name, 'Alice');
    assert.doesNotMatch(JSON.stringify(h.logs), /synthetic-.*-secret|gen_synthetic/);
  });

for (const fault of ['fallback-model', 'fallback-metadata', 'sentinel', 'missing-usage', 'duplicate-metadata'] as const)
  test(`cloud Vercel rejects ${fault} with no fallback or automatic move and preserves valid general work`, async (t) => {
    const h = await cloudFixture(t, { gateway: true, otherLane: true, threshold: 0, movementAttempts: 2 });
    h.handlers.movement = async (body) => {
      const answer = gatewayAnswer(body);
      if (fault === 'fallback-model') answer.model = 'openai/gpt-6-astra';
      if (fault === 'fallback-metadata') answer.provider_metadata.gateway.routing.finalProvider = 'openai';
      if (fault === 'sentinel') {
        const answers = answer.answers as Record<string, { probabilities: Record<string, number>; confidence: number }>;
        for (const a of Object.values(answers)) {
          a.probabilities = {};
          a.confidence = 0;
        }
      }
      if (fault === 'missing-usage') delete answer.usage;
      if (fault === 'duplicate-metadata')
        return new Response(JSON.stringify(answer).replace('"gateway":{', '"gateway":{},"gateway":{'));
      return jsonResponse(answer);
    };
    await h.deliver('one');
    await h.app.pipeline.drain();
    assert.equal(h.calls.length, 2);
    assert.equal(h.sleeps.length, 0);
    assert.equal(listReview(h.ctx).find((r) => r.kind === 'model_failed')?.reason, 'invalid_response');
    assert.equal(getBoard(h.ctx).lanes[0]?.cards.length, 1);
    assert.equal(getBoard(h.ctx).lanes[1]?.cards.length, 0);
    assert.equal(h.app.pipeline.status().movement.state, 'degraded');
  });

for (const otherLane of [false, true])
  test(`cloud Vercel missing gateway key sends zero movement requests, app and human workflow remain usable; destinations=${otherLane}`, async (t) => {
    const h = await cloudFixture(t, { gateway: true, otherLane, missingMovement: true });
    await h.deliver('one');
    await h.app.pipeline.drain();
    assert.equal(h.calls.length, 1);
    assert.equal(h.app.pipeline.status().movement.reason, 'missing_config');
    const review = listReview(h.ctx).find((r) => r.kind === 'new_card');
    assert.ok(review?.canAccept);
    assert.equal((await h.post(`/review/${review.id}/accept`)).status, 303);
    assert.equal(getBoard(h.ctx).lanes[0]?.cards.length, 1);
    assert.equal(getBoard(h.ctx).lanes[1]?.cards.length ?? 0, 0);
    const result = JSON.parse(h.db.get<{ result: string }>('SELECT result FROM movement_decision')?.result ?? '{}');
    assert.equal(result.kind, otherLane ? 'failed' : 'not_requested');
    assert.equal(result.code, otherLane ? 'missing_config' : 'no_destination');
  });

test('cloud Vercel factory blocks non-Jev model at construction without transport and snapshots route config', async (t) => {
  const h = await cloudFixture(t, { gateway: true });
  let sends = 0;
  const deps = {
    db: h.db,
    now: h.ctx.now,
    sleep: async () => {},
    oplog() {},
    http: createMovementHttpPort(async () => {
      sends++;
      return new Response('{}');
    }),
  };
  const config = { ...h.config.movement };
  const provider = await createMovementProvider(config, deps);
  config.endpoint = 'https://api.typesafe.ai/v1/systemone';
  config.model = 'jev-latest';
  assert.equal(provider.status().endpointHost, 'ai-gateway.vercel.sh');
  assert.equal(provider.status().model, 'typesafe-ai/jev');
  const blocked = await createMovementProvider({ ...h.config.movement, model: 'openai/gpt-6-astra' }, deps);
  assert.equal(blocked.status().state, 'blocked');
  assert.equal(blocked.status().reason, 'missing_config');
  assert.equal(sends, 0);
});

test('cloud Vercel provider-held cancellation releases app, late success and rejection cannot repopulate outputs', async (t) => {
  for (const reject of [false, true]) {
    const h = await cloudFixture(t, { gateway: true, otherLane: true, threshold: 0 });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: () => void;
    h.handlers.movement = (body) =>
      new Promise((resolve, fail) => {
        finish = () =>
          reject ? fail(new Error('synthetic-late-private-marker')) : resolve(jsonResponse(gatewayAnswer(body)));
        entered();
      });
    h.handlers.general = async (input) => jsonResponse(completed(decision(input)));
    await h.deliver('one');
    const draining = h.app.pipeline.drain();
    await started;
    await h.app.stop();
    await draining;
    finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.db.all('SELECT * FROM card').length, 0);
    assert.equal(h.db.all('SELECT * FROM review_item').length, 0);
    assert.equal(h.db.all('SELECT * FROM movement_decision').length, 0);
    assert.equal(
      h.db.get<{ processed_version: number }>('SELECT processed_version FROM message')?.processed_version,
      0,
    );
    assert.equal(h.calls.length, 2);
  }
});
