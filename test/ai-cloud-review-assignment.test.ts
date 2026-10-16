import assert from 'node:assert/strict';
import test from 'node:test';
import { cloudFixture, completed, decision, jsonResponse } from '../src/agent/cloud-testing.ts';
import { getReview, listReview } from '../src/agent/index.ts';
import { addTeammate } from '../src/auth/index.ts';
import { attachMessage, createCard } from '../src/board/index.ts';

for (const kind of ['new_card', 'attach', 'is_work'] as const)
  for (const grouped of [false, true])
    test(`F2 two humans stale ${kind}, grouped=${grouped}, rejects acceptance and dismissal without mutation`, async (t) => {
      const h = await cloudFixture(t);
      let target: number | null = null;
      if (kind === 'attach') {
        const chat = h.db.get<{ id: number }>("SELECT id FROM chat WHERE chat_key='work'")?.id;
        assert.ok(chat);
        target = createCard(h.ctx, { laneId: h.lane.id, title: 'Existing target', chatId: chat }).id;
      }
      h.handlers.general = async (input) =>
        jsonResponse(
          completed(
            decision(
              input,
              kind === 'attach'
                ? { disposition: 'attach', cardId: target, laneId: null }
                : kind === 'is_work'
                  ? { disposition: 'none', laneId: null, title: null, summary: null }
                  : input.proposals[0]
                    ? { disposition: 'join', proposalId: input.proposals[0].id, laneId: null }
                    : {},
            ),
          ),
        );
      await h.deliver('one');
      await h.app.pipeline.drain();
      if (grouped) {
        await h.deliver('two');
        await h.app.pipeline.drain();
      }
      const r = listReview(h.ctx).find((r) => r.kind === kind);
      assert.ok(r);
      assert.equal(r.canAccept, true);
      assert.equal(r.messages.length, grouped ? 2 : 1);
      const bob = addTeammate(h.ctx, { username: 'bob', displayName: 'Bob', password: 'synthetic-bob-password' });
      const message = r.messages.at(-1);
      assert.ok(message);
      const bobCtx = { ...h.ctx, actor: { kind: 'teammate' as const, id: bob } };
      const card = createCard(bobCtx, { laneId: h.lane.id, title: 'Bob handles message', messageId: message.id });
      const before = {
        cards: h.db.all('SELECT * FROM card'),
        links: h.db.all('SELECT * FROM card_message'),
        logs: h.db.all('SELECT * FROM action_log'),
      };
      assert.equal(getReview(h.ctx, r.id).canAccept, false);
      assert.equal(listReview(h.ctx).find((x) => x.id === r.id)?.canAccept, false);
      assert.equal((await h.post(`/review/${r.id}/accept`)).status, 409);
      assert.equal((await h.post(`/review/${r.id}/dismiss`)).status, 409);
      assert.deepEqual(
        {
          cards: h.db.all('SELECT * FROM card'),
          links: h.db.all('SELECT * FROM card_message'),
          logs: h.db.all('SELECT * FROM action_log'),
        },
        before,
      );
      assert.equal(
        h.db.get<{ card_id: number }>('SELECT card_id FROM card_message WHERE message_id=?', message.id)?.card_id,
        card.id,
      );
      assert.equal(
        (await h.post(`/review/${r.id}/change`, { to: 'card', cardId: String(card.id) })).status,
        303,
        'fresh explicit human correction remains usable',
      );
    });

test('F2 a grouped question never refreshes an earlier stale human assignment; same-value human history remains stale', async (t) => {
  const h = await cloudFixture(t);
  await h.deliver('one');
  const m = h.db.get<{ id: number }>('SELECT id FROM message')?.id;
  assert.ok(m);
  attachMessage(h.ctx, m, null);
  await h.app.pipeline.drain();
  const r = listReview(h.ctx).find((r) => r.kind === 'new_card');
  assert.ok(r);
  const message = r.messages[0];
  assert.ok(message);
  const before = h.db.get('SELECT * FROM card_message WHERE message_id=?', message.id);
  const card = createCard(h.ctx, { laneId: h.lane.id, title: 'Human interim card', messageId: message.id });
  assert.ok(card);
  attachMessage(h.ctx, message.id, null);
  assert.deepEqual(h.db.get('SELECT * FROM card_message WHERE message_id=?', message.id), before);
  h.handlers.general = async (input) =>
    jsonResponse(completed(decision(input, { disposition: 'join', proposalId: r.id, laneId: null })));
  await h.deliver('two');
  await h.app.pipeline.drain();
  assert.equal(getReview(h.ctx, r.id).canAccept, false);
  assert.equal((await h.post(`/review/${r.id}/accept`)).status, 409);
});
