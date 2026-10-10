import assert from 'node:assert/strict';
import test from 'node:test';
import type { MovementRequest } from '../src/contracts/index.ts';
import { MOVEMENT_LIMITS, MovementRequestSchema } from '../src/contracts/index.ts';
import { MOVEMENT_CASES } from './cases.ts';
import { buildDataset } from './dataset.ts';
import type { RawChoiceEnvelope } from './raw-choices.ts';
import { rawChoices } from './raw-choices.ts';
import { messageKey } from './setup.ts';
import { structuralSnapshot } from './structural-snapshot.ts';

function expectedQuestions(request: MovementRequest): string[] {
  return ['movement', 'support:stay', ...request.options.map((option) => `support:${option.id}`)].sort();
}
// Assertions describe fixture structure only. No parser/normalizer/guard is
// implemented here; those actual product checks remain A1/I1/E2 duties.
function checkFixture(request: MovementRequest, envelope: RawChoiceEnvelope): void {
  assert.deepEqual(Object.keys(envelope.answers).sort(), expectedQuestions(request));
  assert.equal(Object.keys(envelope.answers).length, request.options.length + 2);
  for (const [question, answer] of Object.entries(envelope.answers)) {
    const keys =
      question === 'movement'
        ? [...request.options.map((option) => option.id), 'stay', 'review']
        : [...request.evidenceOptions.map((option) => option.id), 'review'];
    assert.deepEqual(Object.keys(answer.probabilities).sort(), keys.sort());
    assert.equal(answer.type, 'choice');
    assert.ok(keys.includes(answer.choice));
    assert.ok(Number.isFinite(answer.confidence) && answer.confidence >= 0 && answer.confidence <= 1);
    assert.ok(Object.values(answer.probabilities).every((p) => Number.isFinite(p) && p >= 0 && p <= 1));
    assert.ok(Math.abs(Object.values(answer.probabilities).reduce((a, b) => a + b, 0) - 1) <= 1e-6);
    assert.equal(answer.probabilities[answer.choice], Math.max(...Object.values(answer.probabilities)));
  }
}
function target(request: MovementRequest, laneName: string, stageName: string) {
  const lane = request.lanes.find((item) => item.name === laneName);
  const stage = lane?.stages.find((item) => item.name === stageName);
  const option = request.options.find((item) => item.toLaneId === lane?.id && item.toStageId === stage?.id);
  assert.ok(option);
  return option;
}

test('E1 movement structural: complete N+2 target-bound raw Choice envelope, Shipping/m1 differs from Finance/m2', () => {
  const data = buildDataset();
  const key = messageKey(69, 3);
  const request = structuralSnapshot(data, key);
  assert.equal(MovementRequestSchema.safeParse(request).success, true);
  const envelope = rawChoices(request, 'finance');
  checkFixture(request, envelope);
  const shipping = target(request, 'Shipping', 'Done');
  const finance = target(request, 'Finance', 'Paid');
  const shippingSupport = envelope.answers[`support:${shipping.id}`];
  const financeSupport = envelope.answers[`support:${finance.id}`];
  assert.equal(envelope.answers.movement?.choice, finance.id);
  assert.ok(shippingSupport && financeSupport);
  assert.notEqual(shippingSupport.choice, financeSupport.choice);
  const bundleKeys = (id: string) =>
    request.evidenceOptions
      .find((o) => o.id === id)
      ?.messageIds.map((messageId) => request.evidence.find((e) => e.id === messageId)?.key);
  assert.deepEqual(bundleKeys(shippingSupport.choice), [messageKey(69, 1)]);
  assert.deepEqual(bundleKeys(financeSupport.choice), [messageKey(69, 2)]);
  assert.match(request.evidence[0]?.text ?? '', /Shipping m1/);
  assert.match(request.evidence[1]?.text ?? '', /Finance m2/);
  const line = data.movement.find((item) => item.messageKey === key);
  assert.ok(line && 'raw' in line);
  assert.deepEqual(line.raw, envelope);
  assert.equal(envelope.model, null);
  assert.equal(envelope.usage, null);
});

test('E1 movement structural: raw fixtures rebuild from supplied IDs/versions, independent of allocation order', () => {
  const data = buildDataset();
  const request = structuralSnapshot(data, messageKey(69, 3), 10000);
  request.lanes.forEach((lane) => {
    lane.version = 7;
  });
  // A future actual request owns its IDs/versions/options; the fixture consumes
  // supplied option IDs verbatim and never derives assumed lane allocation IDs.
  request.options = request.options.map((option, index) => ({
    ...option,
    id: `actual-option-${index}`,
    laneVersion: 7,
  }));
  const envelope = rawChoices(request, 'finance');
  checkFixture(request, envelope);
  const finance = target(request, 'Finance', 'Paid');
  assert.equal(envelope.answers.movement?.choice, finance.id);
  assert.equal(envelope.answers[`support:${finance.id}`]?.choice, `message:${request.evidence[1]?.id}:v:1`);
  assert.ok(Object.keys(envelope.answers).every((key) => !key.includes('lane:2:v:1')));
});

test('E1 movement structural: stay/review/applicable support-review/unselected-review/confidence cases', () => {
  const request = structuralSnapshot(buildDataset(), messageKey(69, 5));
  for (const mode of ['stay', 'review', 'support-review', 'unselected-review', 'low'] as const)
    checkFixture(request, rawChoices(request, mode));
  const low = rawChoices(request, 'low');
  assert.equal(low.answers.movement?.choice, 'stay');
  assert.equal(low.answers.movement?.probabilities.stay, 0.4);
  assert.equal(low.answers.movement?.confidence, 0.1);
  assert.notEqual(low.answers.movement?.confidence, low.answers.movement?.probabilities.stay);
  assert.equal(rawChoices(request, 'support-review').answers['support:stay']?.choice, 'review');
  const unselected = rawChoices(request, 'unselected-review');
  assert.notEqual(unselected.answers['support:stay']?.choice, 'review');
  assert.ok(request.options.every((option) => unselected.answers[`support:${option.id}`]?.choice === 'review'));
  assert.equal(rawChoices(request, 'review').answers.movement?.choice, 'review');
});

test('E1 movement structural: deliberately invalid complete/partial envelopes identify their exact defect', () => {
  const request = structuralSnapshot(buildDataset(), messageKey(69, 3));
  for (const mode of [
    'invalid-destination',
    'invalid-distribution',
    'missing-answer',
    'generic-support',
    'extra-answer',
  ] as const) {
    assert.throws(() => checkFixture(request, rawChoices(request, mode)), { name: 'AssertionError' }, mode);
  }
  for (const mode of ['invalid-destination', 'invalid-distribution'] as const)
    assert.deepEqual(Object.keys(rawChoices(request, mode).answers).sort(), expectedQuestions(request));
  assert.ok('support' in rawChoices(request, 'generic-support').answers);
  assert.equal(Object.keys(rawChoices(request, 'missing-answer').answers).length, request.options.length + 1);
});

test('E1 movement structural: every declared subject/destination/evidence resolves; no-destination has no invented answer', () => {
  const data = buildDataset();
  const messages = new Map(
    data.recording.flatMap((line) => (line.t === 'message' ? [[line.message.key, line] as const] : [])),
  );
  const seedKeys = new Set(Object.values(data.labels.cards).map((card) => card.createdByMessageKey));
  const seen = new Set<string>();
  for (const line of data.movement) {
    assert.ok(messages.has(line.messageKey));
    assert.equal(line.version, 1);
    const subjectSeed = line.subjectKey.split(':').slice(1).join(':');
    assert.ok(/^(new|card|proposal):/.test(line.subjectKey));
    assert.ok(seedKeys.has(subjectSeed));
    assert.ok(!seen.has(`${line.messageKey}/${line.version}/${line.subjectKey}`));
    seen.add(`${line.messageKey}/${line.version}/${line.subjectKey}`);
    if (!('answer' in line)) continue;
    if (typeof line.answer.destination === 'object') {
      const destination = line.answer.destination;
      assert.ok(
        data.setup.lanes
          .find((lane) => lane.name === destination.lane)
          ?.stages.some((stage) => stage.name === destination.stage),
      );
    }
    for (const key of line.answer.evidenceMessageKeys) {
      assert.equal(messages.get(key)?.chatKey, messages.get(line.messageKey)?.chatKey);
      const evidence = messages.get(key);
      const trigger = messages.get(line.messageKey);
      assert.ok(evidence && trigger);
      assert.ok(evidence.message.sentAt <= trigger.message.sentAt);
    }
    if (line.answer.destination !== 'review') assert.ok(line.answer.evidenceMessageKeys.length > 0);
  }
  assert.ok(!data.movement.some((line) => line.messageKey === messageKey(73, 3)));
  for (const failure of ['unavailable', 'timeout', 'stale', 'invalid_response'])
    assert.ok(data.movement.some((line) => 'failure' in line && line.failure === failure));
  assert.ok(data.movement.some((line) => line.subjectKey.startsWith('new:')));
  assert.ok(data.movement.some((line) => line.subjectKey.startsWith('card:')));
  assert.ok(data.movement.some((line) => line.subjectKey.startsWith('proposal:')));
  assert.equal(MOVEMENT_CASES.length, 23);
});

test('E1 movement structural: complete example fits frozen question/message/byte bounds without truncation', () => {
  const request = structuralSnapshot(buildDataset(), messageKey(69, 3));
  const envelope = rawChoices(request, 'finance');
  assert.ok(request.options.length <= MOVEMENT_LIMITS.transitions);
  assert.ok(expectedQuestions(request).length <= MOVEMENT_LIMITS.questions);
  assert.ok(request.evidence.length <= MOVEMENT_LIMITS.evidenceMessages);
  assert.ok(request.evidenceOptions.length + 1 <= MOVEMENT_LIMITS.supportOptions);
  assert.ok(
    request.evidence.every(
      (e) => Buffer.byteLength(e.text + (e.media ?? ''), 'utf8') <= MOVEMENT_LIMITS.evidenceExcerptBytes,
    ),
  );
  const state = JSON.stringify({
    current: request.current,
    lanes: request.lanes,
    options: request.options,
    evidence: request.evidence,
    evidenceOptions: request.evidenceOptions,
  });
  assert.ok(Buffer.byteLength(state, 'utf8') <= MOVEMENT_LIMITS.stateBytes);
  assert.ok(Buffer.byteLength(JSON.stringify(envelope), 'utf8') <= MOVEMENT_LIMITS.responseBytes);
  // Full production question-template body and overflow zero-call evidence belongs
  // A1/I1. This assertion covers the fixture state/answers, not that unbuilt adapter.
});
