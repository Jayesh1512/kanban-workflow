import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelDecisionSchema } from '../src/contracts/index.ts';

test('eval scaffold reserves the prescribed test glob without model evidence', () => {
  assert.equal(ModelDecisionSchema.safeParse({ disposition: 'delete_card' }).success, false);
});
