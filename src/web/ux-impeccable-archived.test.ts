import assert from 'node:assert/strict';
import test from 'node:test';
import { cloudFixture } from '../agent/cloud-testing.ts';
import { getReview, listReview } from '../agent/index.ts';
import { archiveLane } from '../board/index.ts';

test('UX an archived initial deal destination is labeled and still cannot be approved', async (t) => {
  const h = await cloudFixture(t);
  await h.deliver('one');
  await h.app.pipeline.drain();
  const item = listReview(h.ctx).find((r) => r.kind === 'new_card');
  assert.ok(item);
  archiveLane(h.ctx, h.lane.id);
  assert.equal(getReview(h.ctx, item.id).canAccept, false);
  const response = await h.get(`/review/${item.id}`);
  assert.equal(response.status, 200);
  const page = await response.text();
  assert.match(page.split('<summary>Technical details</summary>')[0] ?? '', /Sales \/ New \(archived\)/);
  assert.doesNotMatch(page, new RegExp(`action="/review/${item.id}/accept"`));
  const snapshot = () => ['card', 'review_item', 'action_log'].map((table) => h.db.all(`SELECT * FROM ${table}`));
  const before = snapshot();
  assert.equal((await h.post(`/review/${item.id}/accept`)).status, 409);
  assert.deepEqual(snapshot(), before);
  assert.equal((await h.post(`/review/${item.id}/dismiss`)).status, 303);
  assert.equal(listReview(h.ctx).length, 0);
  assert.equal(h.calls.length, 1);
});
