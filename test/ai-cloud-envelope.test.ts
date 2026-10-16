import assert from 'node:assert/strict';
import test from 'node:test';
import { cloudFixture, completed, decision } from '../src/agent/cloud-testing.ts';
import { listReview } from '../src/agent/index.ts';

test('cloud production SDK transport rejects duplicate outer Responses envelope keys before parsing loses them', async (t) => {
  const h = await cloudFixture(t);
  h.handlers.general = async (input) =>
    new Response(
      JSON.stringify(completed(decision(input))).replace(
        '"status":"completed"',
        '"status":"incomplete","status":"completed"',
      ),
      { headers: { 'Content-Type': 'application/json' } },
    );
  await h.deliver('one');
  await h.app.pipeline.drain();
  assert.equal(listReview(h.ctx)[0]?.kind, 'model_failed');
});
