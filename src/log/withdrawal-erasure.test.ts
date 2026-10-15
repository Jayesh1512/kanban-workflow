import assert from 'node:assert/strict';
import test from 'node:test';
import { withdrawalFixture } from '../purge/withdrawal-fixture.ts';
import { history, record, redact, redactUnscopedMovementFeedback } from './index.ts';

test('Log erasure follows actual correction copies and global human movement feedback without erasing unrelated human history', async (t) => {
  const f = await withdrawalFixture(t);
  const ids = f.h.db.tx(() => {
    const base = record(f.ctx, {
      action: 'legacy.copy',
      subjectKind: 'chat',
      subjectId: f.chatId,
      reason: 'synthetic private',
      messageIds: f.selected,
    });
    const copy = record(f.ctx, {
      action: 'legacy.correction',
      subjectKind: 'chat',
      subjectId: f.otherChat,
      reason: 'synthetic private',
      correctsId: base,
    });
    const last = record(f.ctx, {
      action: 'legacy.correction',
      subjectKind: 'chat',
      subjectId: f.otherChat,
      reason: 'synthetic private',
      correctsId: copy,
    });
    const kept = record(f.ctx, {
      action: 'company.alias',
      subjectKind: 'company',
      subjectId: f.keptCompany,
      after: { alias: 'RETAIN unrelated human alias' },
    });
    const feedback = record(f.ctx, {
      action: 'card.move',
      subjectKind: 'card',
      subjectId: f.human.id,
      reason: 'unscoped synthetic quote',
    });
    return { base, copy, last, kept, feedback };
  });
  const sel = {
    messageIds: f.selected,
    decisionIds: [],
    cardIds: [],
    reviewItemIds: [],
    contactIds: [],
    companyIds: [],
  };
  redact(f.ctx, sel);
  redactUnscopedMovementFeedback(f.ctx);
  const rows = history(f.ctx, {});
  for (const id of [ids.base, ids.copy, ids.last, ids.feedback]) {
    const r = rows.find((r) => r.id === id);
    assert.ok(r?.redacted);
    assert.equal(r.before, null);
    assert.equal(r.after, null);
    assert.equal(r.reason, '');
  }
  assert.deepEqual(rows.find((r) => r.id === ids.kept)?.after, { alias: 'RETAIN unrelated human alias' });
  assert.equal(rows.find((r) => r.id === ids.kept)?.redacted, false);
});
