import assert from 'node:assert/strict';
import test from 'node:test';
import { attachMessage, createCard, createLane, getCard } from '../board/index.ts';
import { fixture } from '../board/test-fixture.ts';
import { cardReferencePanels, ensureCompany, getCompany, recordReference, removeReference } from './index.ts';

test('B1-F3 R3/R21 panels follow current A-to-B/detach/reattach links, retain company pages, redaction and removal memory', async (t) => {
  const f = await fixture(t),
    m = f.message(f.chatId, 'Mentioned company evidence');
  const lane = createLane(f.ctx, {
    name: 'Work',
    sop: 'Work',
    stages: [
      { name: 'New', criteria: '' },
      { name: 'Done', criteria: 'Complete' },
    ],
  });
  const a = createCard(f.agent, { laneId: lane.id, title: 'A', messageId: m });
  const b = createCard(f.ctx, { laneId: lane.id, title: 'B' });
  const source = ensureCompany(f.ctx, 'Source'),
    target = ensureCompany(f.ctx, 'Target');
  const input = { fromCompanyId: source, toCompanyId: target, messageId: m, cardId: a.id };
  const ref = recordReference(f.agent, input);
  assert.ok(ref);
  const check = (cardId: number | null) => {
    for (const card of [a, b]) {
      const panels = cardReferencePanels(f.ctx, card.id);
      assert.deepEqual(
        panels.map((p) => p.referenceId),
        card.id === cardId ? [ref] : [],
      );
      assert.deepEqual(getCard(f.ctx, card.id).references, panels);
      if (card.id === cardId) {
        assert.equal(panels[0]?.message.cardId, cardId);
        assert.equal(panels[0]?.message.text, 'Mentioned company evidence');
        const redacted = cardReferencePanels({ ...f.ctx, canReadText: false }, card.id);
        assert.equal(redacted[0]?.message.text, null);
        assert.equal(redacted[0]?.message.cardId, cardId);
      }
    }
    const out = getCompany(f.ctx, source).referencesOut;
    const incoming = getCompany({ ...f.ctx, canReadText: false }, target).referencedBy;
    assert.deepEqual(
      out.map((p) => p.referenceId),
      [ref],
    );
    assert.deepEqual(
      incoming.map((p) => p.referenceId),
      [ref],
    );
    assert.equal(out[0]?.message.cardId, cardId);
    assert.equal(incoming[0]?.message.cardId, cardId);
    assert.equal(incoming[0]?.message.text, null);
  };
  check(a.id);
  attachMessage(f.ctx, m, b.id);
  check(b.id);
  assert.equal(recordReference(f.agent, { ...input, cardId: b.id }), ref);
  check(b.id);
  attachMessage(f.ctx, m, null);
  check(null);
  assert.equal(recordReference(f.agent, { ...input, cardId: null }), ref);
  check(null);
  attachMessage(f.ctx, m, a.id);
  check(a.id);
  removeReference(f.ctx, ref);
  attachMessage(f.ctx, m, b.id);
  assert.equal(recordReference(f.agent, { ...input, cardId: b.id }), null);
  assert.deepEqual(cardReferencePanels(f.ctx, a.id), []);
  assert.deepEqual(cardReferencePanels(f.ctx, b.id), []);
  assert.deepEqual(getCompany(f.ctx, source).referencesOut, []);
  assert.deepEqual(getCompany(f.ctx, target).referencedBy, []);
  assert.equal(f.h.db.get<{ removed: number }>('SELECT removed FROM company_reference WHERE id=?', ref)?.removed, 1);
});
