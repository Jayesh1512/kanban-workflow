import assert from 'node:assert/strict';
import test from 'node:test';
import { cloudFixture, completed, decision, jsonResponse } from '../src/agent/cloud-testing.ts';
import { getReview, listReview } from '../src/agent/index.ts';
import { addTeammate } from '../src/auth/index.ts';
import { createCard } from '../src/board/index.ts';
import type { DecideInput, ModelDecision } from '../src/contracts/index.ts';

function joined(input: DecideInput, proposalId: number, invalid: boolean): ModelDecision {
  const participant = input.participants[0];
  assert.ok(participant);
  return decision(input, {
    disposition: 'join',
    proposalId,
    laneId: null,
    title: null,
    summary: 'Both messages describe the same work',
    contacts: invalid
      ? [
          {
            contactId: participant.contactId,
            companyId: null,
            companyName: 'LLC',
            companyConfidence: 1,
            roleCategory: null,
            dealsAbout: null,
            roleConfidence: 0,
            evidenceMessageIds: [input.message.id],
          },
        ]
      : [],
  });
}

for (const attempts of [1, 2] as const)
  for (const invalid of [false, true])
    test(`R2 F3 SDK join survives optional invalid company=${invalid}, captured budget=${attempts}`, async (t) => {
      const h = await cloudFixture(t, { attempts });
      await h.deliver('one');
      await h.app.pipeline.drain();
      const original = listReview(h.ctx).find((r) => r.kind === 'new_card');
      assert.ok(original);
      h.handlers.general = async (input) => jsonResponse(completed(joined(input, original.id, invalid)));
      await h.deliver('two');
      await h.app.pipeline.drain();
      assert.equal(await h.app.pipeline.processNext(), null);
      assert.equal(h.calls.length, 2);
      assert.deepEqual(h.sleeps, []);
      assert.equal(h.db.all('SELECT id FROM message WHERE processed_version<>version').length, 0);
      assert.equal(h.db.all('SELECT id FROM card').length, 0, 'default1 requires an actual human');
      const r = getReview(h.ctx, original.id);
      assert.equal(r.canAccept, true);
      assert.equal(r.messages.length, 2);
      assert.equal((await h.get(`/review/${r.id}`)).status, 200);
      if (invalid) {
        const company = listReview(h.ctx).find((item) => item.kind === 'contact_company');
        assert.ok(company);
        assert.equal(company.canAccept, false);
        assert.equal((await h.post(`/review/${company.id}/accept`)).status, 409);
      }
      assert.equal((await h.post(`/review/${r.id}/accept`)).status, 303);
      const card = h.db.get<{ id: number; summary: string }>('SELECT id,summary FROM card');
      assert.ok(card);
      assert.equal(card.summary, 'Both messages describe the same work');
      assert.equal(h.db.all('SELECT id FROM card').length, 1);
      assert.deepEqual(
        h.db
          .all<{ message_id: number; card_id: number; set_by: string }>(
            'SELECT message_id,card_id,set_by FROM card_message ORDER BY message_id',
          )
          .map((r) => ({ ...r })),
        r.messages.map((m) => ({ message_id: m.id, card_id: card.id, set_by: 'human' })),
      );
      assert.equal(h.db.all('SELECT id FROM company').length, 0);
      assert.ok(
        h.db.get("SELECT id FROM action_log WHERE action='review.accept' AND actor_kind='teammate'"),
        'the actual HTTP approval has a named human owner',
      );
      assert.equal(h.calls.length, 2, 'acceptance must not infer again');
    });

for (const blocked of ['proposal', 'card', 'company', 'contact', 'evidence', 'role'] as const)
  test(`R2 F3 invalid optional company does not authorize a join with unknown ${blocked}`, async (t) => {
    const h = await cloudFixture(t);
    await h.deliver('one');
    await h.app.pipeline.drain();
    const original = listReview(h.ctx).find((r) => r.kind === 'new_card');
    assert.ok(original);
    h.handlers.general = async (input) => {
      const d = joined(input, original.id, true);
      const c = d.contacts[0];
      assert.ok(c);
      if (blocked === 'proposal') d.proposalId = 999999;
      if (blocked === 'card') d.cardId = 999999;
      if (blocked === 'company') d.cardCompanyId = 999999;
      if (blocked === 'contact') c.contactId = 999999;
      if (blocked === 'evidence') c.evidenceMessageIds = [999999];
      if (blocked === 'role') {
        c.roleCategory = 'unoffered-role';
        c.dealsAbout = 'Unknown role';
      }
      return jsonResponse(completed(d));
    };
    await h.deliver('two');
    await h.app.pipeline.drain();
    assert.equal(await h.app.pipeline.processNext(), null);
    assert.equal(h.calls.length, 2);
    const r = getReview(h.ctx, original.id);
    assert.equal(r.messages.length, 1);
    assert.ok(listReview(h.ctx).some((item) => item.kind === 'model_failed' && !item.canAccept));
    assert.equal((await h.post(`/review/${r.id}/accept`)).status, 303);
    assert.equal(h.db.all('SELECT message_id FROM card_message WHERE card_id IS NOT NULL').length, 1);
  });

test('R2 F3 join with refused company retains F2 prior Bob assignment fence', async (t) => {
  const h = await cloudFixture(t);
  await h.deliver('one');
  await h.app.pipeline.drain();
  const original = listReview(h.ctx).find((r) => r.kind === 'new_card');
  assert.ok(original);
  const message = original.messages[0];
  assert.ok(message && original.chat);
  const bob = addTeammate(h.ctx, { username: 'bob', displayName: 'Bob', password: 'synthetic-bob-password' });
  const manual = createCard(
    { ...h.ctx, actor: { kind: 'teammate', id: bob } },
    { laneId: h.lane.id, title: 'Bob selected', chatId: original.chat.id, messageId: message.id },
  );
  h.handlers.general = async (input) => jsonResponse(completed(joined(input, original.id, true)));
  await h.deliver('two');
  await h.app.pipeline.drain();
  assert.equal(getReview(h.ctx, original.id).canAccept, false);
  const snapshot = () =>
    ['card', 'card_message', 'review_item', 'action_log'].map((table) => h.db.all(`SELECT * FROM ${table}`));
  const before = snapshot();
  assert.equal((await h.post(`/review/${original.id}/accept`)).status, 409);
  assert.deepEqual(snapshot(), before);
  assert.equal(
    h.db.get<{ card_id: number }>('SELECT card_id FROM card_message WHERE message_id=?', message.id)?.card_id,
    manual.id,
  );
  assert.equal(h.calls.length, 2);
});

test('R2 F3 actual join owner-log fault rolls back all decision and settlement writes', async (t) => {
  const h = await cloudFixture(t);
  await h.deliver('one');
  await h.app.pipeline.drain();
  const original = listReview(h.ctx).find((r) => r.kind === 'new_card');
  assert.ok(original);
  h.handlers.general = async (input) => jsonResponse(completed(joined(input, original.id, true)));
  await h.deliver('two');
  const snapshot = () =>
    ['message', 'decision', 'review_item', 'review_message', 'action_log'].map((table) =>
      h.db.all(`SELECT * FROM ${table}`),
    );
  const before = snapshot();
  h.db.run(
    "CREATE TEMP TRIGGER fail_r2_join BEFORE INSERT ON action_log WHEN NEW.action='review.join' BEGIN SELECT RAISE(ABORT,'synthetic R2 join log fault'); END",
  );
  await assert.rejects(h.app.pipeline.processNext(), /synthetic R2 join log fault/);
  assert.deepEqual(snapshot(), before);
  assert.equal(h.calls.length, 2, 'persistence error does not reopen the attempt budget');
  h.db.run('DROP TRIGGER fail_r2_join');
  await h.app.pipeline.processNext();
  assert.equal(getReview(h.ctx, original.id).messages.length, 2);
  assert.equal((await h.post(`/review/${original.id}/accept`)).status, 303);
  assert.equal(h.db.all('SELECT message_id FROM card_message WHERE card_id IS NOT NULL').length, 2);
});
