import assert from 'node:assert/strict';
import test from 'node:test';
import type { Ctx } from '../contracts/index.ts';
import { openDb } from '../store/index.ts';
import { boardVersion, history, record, redact } from './index.ts';
import { createOpLog } from './operational.ts';

test('F0 R14 action log is atomic, append-only, filtered and selectively redacted', () => {
  const db = openDb(':memory:');
  const ctx: Ctx = {
    db,
    actor: { kind: 'system' },
    canReadText: true,
    now: () => new Date('2026-09-01T00:00:00.000Z'),
  };
  try {
    assert.throws(() => record(ctx, { action: 'card.create', subjectKind: 'card', subjectId: 1 }), /require Db.tx/);
    assert.throws(() =>
      db.tx(() => {
        record(ctx, {
          action: 'card.create',
          subjectKind: 'card',
          subjectId: 1,
          after: { title: 'Synthetic marker' },
          messageIds: [7],
        });
        throw new Error('rollback');
      }),
    );
    assert.equal(boardVersion(db), 0);
    const id = db.tx(() =>
      record(ctx, {
        action: 'card.create',
        subjectKind: 'card',
        subjectId: 1,
        after: { title: 'Synthetic marker' },
        messageIds: [7],
        reason: 'Synthetic reason',
      }),
    );
    db.tx(() =>
      record(ctx, { action: 'setting.update', subjectKind: 'setting', subjectId: null, after: { value: 1 } }),
    );
    assert.equal(history(ctx, { subjectKind: 'card' }).length, 1);
    assert.equal(history(ctx, { beforeId: id }).length, 0);
    assert.throws(
      () => db.tx(() => db.run('DELETE FROM action_log WHERE id=?', id)),
      /append-only|redaction must erase/,
    );
    assert.throws(
      () => db.tx(() => db.run("UPDATE action_log SET reason='tampered' WHERE id=?", id)),
      /append-only|redaction must erase/,
    );
    const count = redact(ctx, {
      messageIds: [7],
      decisionIds: [],
      cardIds: [],
      reviewItemIds: [],
      contactIds: [],
      companyIds: [],
    });
    assert.equal(count, 1);
    const entry = history(ctx, { subjectKind: 'card' })[0];
    assert.equal(entry?.redacted, true);
    assert.equal(entry?.after, null);
    assert.equal(entry?.reason, '');
    assert.deepEqual(entry?.messageIds, []);
    assert.equal(history(ctx, { subjectKind: 'setting' })[0]?.redacted, false);
  } finally {
    db.close();
  }
});

test('F0 operational logger uses its injected clock and writes JSON lines', () => {
  const lines: string[] = [];
  const log = createOpLog(
    () => new Date('2026-09-01T00:00:00.000Z'),
    (line) => lines.push(line),
  );
  log('info', 'synthetic.test', { count: 2 });
  assert.deepEqual(JSON.parse(lines[0] ?? ''), {
    at: '2026-09-01T00:00:00.000Z',
    level: 'info',
    event: 'synthetic.test',
    count: 2,
  });
});

test('I1 R14.3 exact-erasure trigger rejects replacement content and audit metadata changes', () => {
  const db = openDb(':memory:');
  const ctx: Ctx = {
    db,
    actor: { kind: 'system' },
    canReadText: true,
    now: () => new Date('2026-10-10T00:00:00.000Z'),
  };
  try {
    const id = db.tx(() =>
      record(ctx, { action: 'company.create', subjectKind: 'company', subjectId: 9, after: { name: 'erase-marker' } }),
    );
    for (const sql of [
      "UPDATE action_log SET redacted=1,after='{}' WHERE id=?",
      "UPDATE action_log SET redacted=1,before=NULL,after=NULL,reason='',message_ids='[]',decision_id=99 WHERE id=?",
      "UPDATE action_log SET redacted=1,before=NULL,after=NULL,reason='',message_ids='[]',follows_human_override=1 WHERE id=?",
    ])
      assert.throws(() => db.tx(() => db.run(sql, id)), /redaction must erase/);
    assert.equal(history(ctx, {})[0]?.redacted, false);
    assert.equal(
      redact(ctx, { messageIds: [], decisionIds: [], cardIds: [], reviewItemIds: [], contactIds: [], companyIds: [9] }),
      1,
    );
    assert.equal(history(ctx, {})[0]?.after, null);
    assert.equal(
      redact(ctx, { messageIds: [], decisionIds: [], cardIds: [], reviewItemIds: [], contactIds: [], companyIds: [9] }),
      0,
    );
    assert.throws(() => history(ctx, { from: 'bad timestamp' }), { code: 'invalid' });
  } finally {
    db.close();
  }
});
