import assert from 'node:assert/strict';
import test from 'node:test';
import { getBoard } from '../src/board/index.ts';
import type { Ctx } from '../src/contracts/index.ts';
import { BoardViewSchema } from '../src/contracts/index.ts';
import { openDb } from '../src/store/db.ts';

test('F2 review regression: actual fresh database board validates version zero', (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  const ctx: Ctx = {
    db,
    actor: { kind: 'system' },
    canReadText: true,
    now: () => new Date('2026-10-10T07:08:30.000Z'),
  };
  const board = getBoard(ctx);
  assert.deepEqual(board, { version: 0, lanes: [], openReviewCount: 0 });
  assert.deepEqual(BoardViewSchema.parse(board), board);
  assert.equal(db.get<{ count: number }>('SELECT count(*) AS count FROM action_log')?.count, 0);
});

test('F2 review regression: board versions remain safe nonnegative integers', () => {
  const board = { version: 0, lanes: [], openReviewCount: 0 };
  for (const version of [0, 1, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(BoardViewSchema.parse({ ...board, version }), { ...board, version });
  }
  for (const version of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity, '0', null, undefined]) {
    assert.equal(BoardViewSchema.safeParse({ ...board, version }).success, false);
  }
});
