import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CardSummarySchema,
  ChatRefSchema,
  FixtureLineSchema,
  ModelDecisionSchema,
  MovementResultSchema,
  ScriptLineSchema,
  WriteOptsSchema,
} from './index.ts';
import { modelDecisionJsonSchema } from './provider-schema.ts';

test('F0 strict decision/script contracts reject extra actions and invalid confidence', () => {
  const decision = {
    disposition: 'none',
    cardId: null,
    proposalId: null,
    laneId: null,
    title: null,
    summary: null,
    cardCompanyId: null,
    cardCompanyName: null,
    confidence: 1,
    reason: 'synthetic',
    move: null,
    contacts: [],
    mentions: [],
  };
  assert.equal(ModelDecisionSchema.safeParse(decision).success, true);
  assert.equal(ModelDecisionSchema.safeParse({ ...decision, confidence: 2 }).success, false);
  assert.equal(ModelDecisionSchema.safeParse({ ...decision, sendMessage: 'forbidden' }).success, false);
  assert.equal(ScriptLineSchema.safeParse({ messageKey: 'm', version: 1, raw: { forbidden: true } }).success, true);
  assert.equal(ScriptLineSchema.safeParse({ messageKey: 'm', version: 0, raw: null }).success, false);
  assert.equal(FixtureLineSchema.safeParse({ t: 'mark', name: 'start', extra: 1 }).success, false);
});

test('F0 movement result retains nullable target-bound support and typed disabled metadata', () => {
  const base = {
    provider: 'jev',
    execution: 'disabled',
    configuredModel: null,
    providerRequestId: null,
    schemaVersion: 1,
    requestId: 'synthetic',
    snapshotHash: 'a'.repeat(64),
  };
  assert.equal(MovementResultSchema.safeParse({ ...base, kind: 'failed', code: 'missing_config' }).success, true);
  assert.equal(
    MovementResultSchema.safeParse({ ...base, kind: 'not_requested', code: 'no_destination' }).success,
    true,
  );
  assert.equal(
    MovementResultSchema.safeParse({
      ...base,
      kind: 'answered',
      resolvedModel: null,
      movement: { choice: 'review', confidence: 1, probabilities: { review: 1 } },
      support: null,
      supportTarget: null,
      supportQuestionId: null,
      usage: null,
    }).success,
    true,
  );
});

test('F0 connector/display text is not constrained by model-generated title bounds', () => {
  const chat = { key: 'chat', nativeId: 'chat', kind: 'direct', title: '' };
  assert.equal(ChatRefSchema.safeParse(chat).success, true);
  assert.equal(ChatRefSchema.safeParse({ ...chat, title: 'x'.repeat(200) }).success, true);
  assert.equal(WriteOptsSchema.safeParse({ reason: '' }).success, true);
  assert.equal(CardSummarySchema.shape.title.safeParse('x'.repeat(200)).success, true);
  assert.equal(ModelDecisionSchema.shape.title.safeParse('x'.repeat(81)).success, false);
});

test('F1 Responses metadata keeps strict required nullable structure while Zod owns application bounds', () => {
  assert.equal(modelDecisionJsonSchema.type, 'object');
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    for (const keyword of ['const', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'format'])
      assert.equal(keyword in node, false);
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual(
        new Set(node.required as string[]),
        new Set(Object.keys(node.properties as Record<string, unknown>)),
      );
    }
    for (const entry of Object.values(node)) visit(entry);
  };
  visit(modelDecisionJsonSchema);
});
