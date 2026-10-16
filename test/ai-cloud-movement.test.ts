import assert from 'node:assert/strict';
import test from 'node:test';
import { cloudFixture, completed, decision, jevAnswer, jsonResponse } from '../src/agent/cloud-testing.ts';
import { createMovementProvider, listReview } from '../src/agent/index.ts';
import { getBoard } from '../src/board/index.ts';
import type { MovementRequest } from '../src/contracts/index.ts';
import { createMovementHttpPort } from '../src/store/provider-ports.ts';

for (const fault of [
  'missing',
  'unknown',
  'duplicate-json',
  'duplicate-question',
  'unselected',
  'probability-keys',
  'sum',
  'not-max',
  'model',
  'usage',
  'type',
  'extra-text',
] as const)
  test(`cloud Jev entire independent wire set rejects ${fault} and never retries invalid answers`, async (t) => {
    const h = await cloudFixture(t, { otherLane: true, threshold: 0, movementAttempts: 2 });
    h.handlers.movement = async (body) => {
      const value = jevAnswer(body) as {
        model: string;
        answers: Record<
          string,
          { type: string; choice: string; confidence: number; probabilities: Record<string, number>; text?: string }
        >;
        usage?: unknown;
      };
      const ids = Object.keys(value.answers);
      const first = value.answers.movement;
      assert.ok(first);
      const unselected = value.answers[ids.find((id) => id.startsWith('support:lane:')) ?? ''];
      assert.ok(unselected);
      if (fault === 'missing') delete value.answers[ids[1] ?? ''];
      if (fault === 'unknown') value.answers.unknown = { ...first };
      if (fault === 'duplicate-json')
        return new Response('{"model":"jev-1.13.0","model":"jev-1.13.0"}', {
          headers: { 'Content-Type': 'application/json' },
        });
      if (fault === 'duplicate-question') {
        const raw = JSON.stringify(value).replace('"answers":{', '"answers":{"movement":{},');
        return new Response(raw, { headers: { 'Content-Type': 'application/json' } });
      }
      if (fault === 'unselected') unselected.confidence = -1;
      if (fault === 'probability-keys') first.probabilities.unknown = 0;
      if (fault === 'sum') first.probabilities.stay = 0.5;
      if (fault === 'not-max') {
        first.probabilities.stay = 0;
        first.probabilities.review = 1;
      }
      if (fault === 'model') value.model = 'non-jev-version';
      if (fault === 'usage') delete value.usage;
      if (fault === 'type') first.type = 'noul';
      if (fault === 'extra-text') unselected.text = 'UNTRUSTED-PROVIDER-PROSE';
      return jsonResponse(value);
    };
    await h.deliver('one');
    await h.app.pipeline.drain();
    assert.equal(h.calls.filter((c) => c.url.includes('typesafe')).length, 1);
    const failure = listReview(h.ctx).find((r) => r.kind === 'model_failed');
    assert.ok(failure);
    assert.equal(failure.reason, 'invalid_response');
    assert.equal(failure.canAccept, false);
    assert.equal(getBoard(h.ctx).lanes[0]?.cards.length, 1);
    assert.equal(getBoard(h.ctx).lanes[1]?.cards.length, 0);
    assert.doesNotMatch(JSON.stringify(h.db.all('SELECT * FROM movement_decision')), /UNTRUSTED-PROVIDER-PROSE/);
  });

for (const status of [401, 403, 429, 503])
  test(`cloud Jev HTTP ${status} uses bounded whole-request attempts, typed status, and keeps general work usable`, async (t) => {
    const h = await cloudFixture(t, { otherLane: true, threshold: 0, movementAttempts: 2 });
    h.handlers.movement = async () => jsonResponse({ error: 'PRIVATE-JEV-ERROR' }, status);
    await h.deliver('one');
    await h.app.pipeline.drain();
    assert.equal(h.calls.filter((c) => c.url.includes('typesafe')).length, status < 429 ? 1 : 2);
    assert.deepEqual(h.sleeps, status < 429 ? [] : [1000]);
    assert.equal(h.app.pipeline.status().movement.state, status < 429 ? 'blocked' : 'degraded');
    assert.equal(getBoard(h.ctx).lanes[0]?.cards.length, 1);
    assert.doesNotMatch(JSON.stringify(h.db.all('SELECT * FROM movement_decision')), /PRIVATE-JEV/);
  });

test('cloud correctly bound Jev stay releases same-lane guard only above threshold; unselected support-review is irrelevant', async (t) => {
  const h = await cloudFixture(t, { otherLane: true, threshold: 0.8 });
  h.handlers.general = async (input) =>
    jsonResponse(
      completed(
        decision(input, {
          move: {
            toStageId: h.lane.stages[1]?.id as number,
            criterion: 'Delivered',
            confidence: 0.95,
            evidenceMessageIds: [input.message.id],
          },
        }),
      ),
    );
  h.handlers.movement = async (body) => jsonResponse(jevAnswer(body, 'stay', 0.95));
  await h.deliver('one');
  await h.app.pipeline.drain();
  assert.equal(getBoard(h.ctx).lanes[0]?.cards[0]?.stageId, h.lane.stages[1]?.id);
  assert.equal(listReview(h.ctx).length, 0);
});

for (const binding of ['target', 'question', 'missing'] as const)
  test(`cloud pipeline rejects injected normalized wrong ${binding} binding after actual Jev parsing`, async (t) => {
    const h = await cloudFixture(t, { otherLane: true, threshold: 0 });
    h.handlers.normalized = (r) =>
      r.kind !== 'answered'
        ? r
        : {
            ...r,
            supportTarget: binding === 'target' ? 'unselected' : r.supportTarget,
            supportQuestionId:
              binding === 'question' ? 'support:unselected' : binding === 'missing' ? null : r.supportQuestionId,
          };
    await h.deliver('one');
    await h.app.pipeline.drain();
    assert.equal(listReview(h.ctx).find((r) => r.kind === 'model_failed')?.reason, 'invalid_response');
    assert.equal(h.db.get<{ status: string }>('SELECT status FROM movement_decision')?.status, 'failed');
  });

test('cloud hosted Jev zero-destination is typed not_requested even with missing config and sends no HTTP', async (t) => {
  const h = await cloudFixture(t, { missingMovement: true });
  await h.deliver('one');
  await h.app.pipeline.drain();
  assert.equal(h.calls.length, 1);
  const raw = h.db.get<{ result: string }>('SELECT result FROM movement_decision')?.result;
  const result = JSON.parse(raw ?? '{}');
  assert.equal(result.kind, 'not_requested');
  assert.equal(result.code, 'no_destination');
  assert.equal(Object.hasOwn(result, 'movement'), false);
});

test('cloud configured noncanonical Jev endpoint is blocked with no fetch; replay raw fixtures retain replay execution', async (t) => {
  const h = await cloudFixture(t, { otherLane: true });
  let request: MovementRequest | null = null;
  h.handlers.movement = async (body) => {
    const state = JSON.parse(body.state);
    assert.equal(state.options.length, 2);
    return jsonResponse(jevAnswer(body));
  };
  // The complete immutable application request is captured at the provider boundary,
  // then replayed through the declared raw-fixture factory on the same synthetic DB.
  const { movementRequest } = await import('../src/agent/movement/subject.ts');
  h.handlers.general = async (input) => {
    request = movementRequest(h.ctx, input, decision(input));
    return jsonResponse(completed(decision(input)));
  };
  await h.deliver('one');
  await h.app.pipeline.drain();
  assert.ok(request);
  let count = 0;
  const blocked = await createMovementProvider(
    { ...h.config.movement, endpoint: 'https://example.invalid/v1/systemone' },
    {
      db: h.db,
      oplog() {},
      now: h.ctx.now,
      async sleep() {},
      http: createMovementHttpPort(async () => {
        count++;
        throw new Error('No network');
      }),
    },
  );
  const result = await blocked.decide(request, new AbortController().signal);
  assert.equal(result.kind, 'failed');
  assert.equal(blocked.status().reason, 'endpoint_blocked');
  assert.equal(count, 0);
  const wireCall = h.calls.find((c) => c.url.includes('typesafe'));
  assert.ok(wireCall);
  const replay = await createMovementProvider(
    { ...h.config.movement, provider: 'replay', replayPath: null },
    {
      db: h.db,
      oplog() {},
      now: h.ctx.now,
      async sleep() {},
      http: createMovementHttpPort(async () => {
        throw new Error('No network');
      }),
      replayLines: [
        {
          messageKey: 'one',
          version: 1,
          subjectKey: 'new:one',
          raw: jevAnswer(wireCall.input as Parameters<typeof jevAnswer>[0]),
        },
      ],
    },
  );
  assert.equal((await replay.decide(request, new AbortController().signal)).execution, 'replay');
});
