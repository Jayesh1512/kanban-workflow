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
    assert.throws(() => db.tx(() => db.run('DELETE FROM action_log WHERE id=?', id)), /append-only/);
    assert.throws(() => db.tx(() => db.run("UPDATE action_log SET reason='tampered' WHERE id=?", id)), /append-only/);
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
