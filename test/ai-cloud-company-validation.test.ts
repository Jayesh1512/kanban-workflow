import assert from 'node:assert/strict';
import test from 'node:test';
import { onlyCompany } from '../src/agent/cloud-company-testing.ts';
import { cloudFixture, completed, jsonResponse } from '../src/agent/cloud-testing.ts';
import { getReview, listReview } from '../src/agent/index.ts';
import { getBoard } from '../src/board/index.ts';
import { ensureCompany } from '../src/graph/index.ts';

for (const name of ['LLC', 'pvt ltd', '...', '\u0301\u200b'])
  for (const threshold of [0, 1])
    test(`F3 normalized-empty ${JSON.stringify(name)} at threshold ${threshold} settles independent work once and supports valid human correction`, async (t) => {
      const h = await cloudFixture(t, { threshold });
      h.handlers.general = async (input) =>
        jsonResponse(
          completed({
            ...onlyCompany(input, name),
            disposition: 'create',
            laneId: h.lane.id,
            title: 'Valid independent work',
            summary: 'Valid independent summary',
            cardCompanyName: name,
            mentions: [{ name, companyId: null, confidence: 1 }],
          }),
        );
      await h.deliver('one');
      assert.ok(await h.app.pipeline.processNext());
      assert.equal(await h.app.pipeline.processNext(), null);
      assert.equal(h.calls.length, 1);
      const m = h.db.get<{ version: number; processed_version: number }>(
        'SELECT version,processed_version FROM message',
      );
      assert.equal(m?.processed_version, m?.version);
      const p = listReview(h.ctx).find((r) => r.kind === 'contact_company');
      assert.ok(p);
      assert.equal(p.canAccept, false);
      assert.equal((await h.post(`/review/${p.id}/accept`)).status, 409);
      assert.equal((await h.get(`/review/${p.id}`)).status, 200);
      if (threshold === 1) {
        const card = listReview(h.ctx).find((r) => r.kind === 'new_card');
        assert.ok(card);
        assert.equal(card.canAccept, true);
        assert.equal((await h.post(`/review/${card.id}/accept`)).status, 303);
      }
      assert.equal(getBoard(h.ctx).lanes[0]?.cards.length, 1);
      assert.equal(h.db.get('SELECT id FROM company'), undefined);
      assert.equal(h.db.get('SELECT id FROM pending_mention'), undefined);
      const failed = listReview(h.ctx).find((r) => r.kind === 'model_failed');
      assert.ok(failed);
      assert.equal((await h.post(`/review/${failed.id}/dismiss`)).status, 303);
      assert.equal(getBoard(h.ctx).lanes[0]?.cards.length, 1);
      assert.ok(h.db.get('SELECT card_id FROM card_message WHERE card_id IS NOT NULL'));
      assert.equal(
        (await h.post(`/review/${p.id}/change`, { to: 'company', company: 'Human valid business' })).status,
        303,
      );
      assert.equal(h.db.get<{ name: string }>('SELECT name FROM company')?.name, 'Human valid business');
    });

test('F3 unexpected Graph owner SQL fault still rolls back independent card and processed writes', async (t) => {
  const h = await cloudFixture(t, { threshold: 0 });
  h.handlers.general = async (input) =>
    jsonResponse(
      completed({
        ...onlyCompany(input, 'Valid faulted business'),
        disposition: 'create',
        laneId: h.lane.id,
        title: 'Valid card',
        summary: 'Valid summary',
      }),
    );
  await h.deliver('one');
  h.db.run(
    "CREATE TEMP TRIGGER fail_valid_company BEFORE INSERT ON company BEGIN SELECT RAISE(ABORT,'unexpected Graph persistence fault'); END",
  );
  await assert.rejects(h.app.pipeline.processNext(), /unexpected Graph persistence fault/);
  for (const table of ['card', 'decision', 'review_item', 'company'])
    assert.equal(h.db.get(`SELECT * FROM ${table}`), undefined, table);
  assert.equal(h.db.get<{ processed_version: number }>('SELECT processed_version FROM message')?.processed_version, 0);
});

for (const kind of ['contact_company', 'name_company'] as const)
  test(`F3 legacy invalid stored ${kind} never advertises acceptance; explicit valid company correction settles held use`, async (t) => {
    const h = await cloudFixture(t);
    if (kind === 'name_company') ensureCompany(h.ctx, 'Northstar Laboratories');
    h.handlers.general = async (input) =>
      jsonResponse(
        completed(onlyCompany(input, kind === 'name_company' ? 'Northstar Laboratory' : 'Valid question business')),
      );
    await h.deliver('one');
    await h.app.pipeline.drain();
    const r = listReview(h.ctx).find((r) => r.kind === kind);
    assert.ok(r);
    // Negative compatibility fixture: corrupt only the proposed name on a genuine
    // SDK-produced question, as an older schema-valid record could contain it.
    // No output, decision, support or acceptability provenance is manufactured.
    const p = r.proposal;
    assert.ok(p.kind === 'contact_company' || p.kind === 'name_company');
    const legacy = p.kind === 'contact_company' ? { ...p, company: { name: 'LLC' } } : { ...p, name: 'LLC' };
    h.db.run('UPDATE review_item SET proposal=? WHERE id=?', JSON.stringify(legacy), r.id);
    await h.restart();
    assert.equal(getReview(h.ctx, r.id).canAccept, false);
    assert.equal((await h.post(`/review/${r.id}/accept`)).status, 409);
    assert.equal(
      (await h.post(`/review/${r.id}/change`, { to: 'company', company: 'Human corrected legacy business' })).status,
      303,
    );
    assert.ok(h.db.get("SELECT id FROM company WHERE name='Human corrected legacy business'"));
  });
