import assert from 'node:assert/strict';
import test from 'node:test';
import type { MovementRequest } from '../src/contracts/index.ts';
import { MovementRequestSchema } from '../src/contracts/index.ts';
import { rawEvidenceFor } from './cases.ts';
import { buildDataset } from './dataset.ts';
import { digest, mismatchedSupportFixture, rawChoices } from './raw-choices.ts';
import { structuralSnapshot } from './structural-snapshot.ts';

const selectors = { primaryMessageKey: 'm-070-002', financeMessageKey: 'm-070-003' };
function suppliedRequest(): MovementRequest {
  const data = buildDataset();
  const request = structuralSnapshot(data, 'm-070-004', 10000);
  const opening = data.recording.find((line) => line.t === 'message' && line.message.key === 'm-070-001');
  assert.ok(opening?.t === 'message');
  const ids = new Map([
    ['m-070-001', 9001],
    ['m-070-002', 57103],
    ['m-070-003', 307],
    ['m-070-004', 88019],
  ]);
  request.evidence = [
    {
      id: 9001,
      key: opening.message.key,
      version: 1,
      sentAt: opening.message.sentAt,
      text: opening.message.text,
      media: opening.message.media,
      replyToId: null,
    },
    ...request.evidence.map((item) => ({ ...item, id: ids.get(item.key) ?? item.id })),
  ];
  const trigger = request.evidence.find((item) => item.key === request.message.key);
  assert.ok(trigger);
  request.message.id = trigger.id;
  request.evidenceOptions = request.evidence.map((item) => ({
    id: `message:${item.id}:v:${item.version}`,
    messageIds: [item.id],
  }));
  const pairs = request.evidence.map((item) => [item.id, item.version]).sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
  request.evidenceOptions.push({
    id: `all:${digest(pairs)}`,
    messageIds: request.evidence.map((item) => item.id).sort((a, b) => a - b),
  });
  request.snapshotHash = digest(request.evidence);
  return request;
}
function assertCompleteNamedAnswers(request: MovementRequest): void {
  assert.equal(MovementRequestSchema.safeParse(request).success, true, 'Additional opening evidence is permitted');
  const envelope = rawChoices(request, 'finance', selectors);
  assert.deepEqual(
    Object.keys(envelope.answers).sort(),
    ['movement', 'support:stay', ...request.options.map((item) => `support:${item.id}`)].sort(),
  );
  let financeId: string | undefined;
  for (const [question, answer] of Object.entries(envelope.answers)) {
    const offered =
      question === 'movement'
        ? [...request.options.map((item) => item.id), 'stay', 'review']
        : [...request.evidenceOptions.map((item) => item.id), 'review'];
    assert.deepEqual(Object.keys(answer.probabilities).sort(), offered.sort());
    assert.ok(offered.includes(answer.choice));
    assert.equal(answer.type, 'choice');
    assert.equal(
      Object.values(answer.probabilities).reduce((a, b) => a + b, 0),
      1,
    );
    assert.equal(answer.probabilities[answer.choice], 1);
    assert.ok(Object.values(answer.probabilities).every((p) => p === 0 || p === 1));
    assert.ok(answer.confidence >= 0 && answer.confidence <= 1);
    if (question === 'movement') continue;
    const option = request.options.find((item) => question === `support:${item.id}`);
    const lane = request.lanes.find((item) => item.id === option?.toLaneId);
    const stage = lane?.stages.find((item) => item.id === option?.toStageId);
    const finance = lane?.name === 'Finance' && stage?.name === 'Paid';
    if (finance) financeId = option?.id;
    const bundle = request.evidenceOptions.find((item) => item.id === answer.choice);
    assert.ok(bundle);
    assert.deepEqual(
      bundle.messageIds.map((id) => request.evidence.find((item) => item.id === id)?.key),
      [finance ? 'm-070-003' : 'm-070-002'],
      `${question} must keep its named logical evidence despite additional or reordered evidence`,
    );
  }
  assert.ok(financeId);
  assert.equal(envelope.answers.movement?.choice, financeId);
  assert.equal(envelope.model, null);
  assert.equal(envelope.usage, null);
  const mismatch = mismatchedSupportFixture(request, selectors);
  assert.ok(mismatch.kind === 'answered');
  assert.equal(mismatch.movement.choice, financeId);
  const shipping = request.options.find((option) => {
    const lane = request.lanes.find((item) => item.id === option.toLaneId);
    return lane?.name === 'Shipping' && lane.stages.find((item) => item.id === option.toStageId)?.name === 'Done';
  });
  assert.ok(shipping);
  assert.equal(mismatch.supportTarget, shipping.id);
  assert.equal(mismatch.supportQuestionId, `support:${shipping.id}`);
  assert.equal(mismatch.support?.choice, envelope.answers[`support:${financeId}`]?.choice);
  assert.equal(mismatch.requestId, request.requestId);
  assert.equal(mismatch.snapshotHash, request.snapshotHash);
  assert.equal(mismatch.execution, 'replay');
  assert.equal(mismatch.configuredModel, null);
  assert.equal(mismatch.resolvedModel, null);
  assert.equal(mismatch.providerRequestId, null);
  assert.equal(mismatch.usage, null);
}

test('E1-F2 structural: valid opening evidence and reordered tables preserve all N+2 named support semantics', () => {
  const request = suppliedRequest();
  assertCompleteNamedAnswers(request);
  for (const order of [
    [2, 0, 3, 1],
    [3, 2, 1, 0],
    [1, 3, 0, 2],
  ]) {
    const permuted = structuredClone(request);
    permuted.evidence = order.map((index) => {
      const item = request.evidence[index];
      assert.ok(item);
      return item;
    });
    permuted.evidenceOptions.reverse();
    permuted.options.reverse();
    permuted.lanes.reverse();
    for (const lane of permuted.lanes) lane.stages.reverse();
    assertCompleteNamedAnswers(permuted);
  }
});

test('E1-F2 structural: absent required logical evidence or singleton fails visibly with no fallback', () => {
  for (const key of ['m-070-002', 'm-070-003']) {
    const request = suppliedRequest();
    const id = request.evidence.find((item) => item.key === key)?.id;
    request.evidence = request.evidence.filter((item) => item.key !== key);
    request.evidenceOptions = request.evidenceOptions.filter((item) => !item.messageIds.includes(id ?? 0));
    assert.equal(MovementRequestSchema.safeParse(request).success, true);
    assert.throws(() => rawChoices(request, 'finance', selectors), /required evidence key/i, key);
    const missingSingleton = suppliedRequest();
    missingSingleton.evidenceOptions = missingSingleton.evidenceOptions.filter(
      (item) => !(item.messageIds.length === 1 && item.messageIds[0] === id),
    );
    assert.equal(MovementRequestSchema.safeParse(missingSingleton).success, true);
    assert.throws(() => rawChoices(missingSingleton, 'finance', selectors), /singleton/i, key);
  }
});

test('E1-F2 structural: ambiguous logical keys and singleton bundles fail visibly', () => {
  const duplicateKey = suppliedRequest();
  const item = duplicateKey.evidence.find((entry) => entry.key === 'm-070-002');
  assert.ok(item);
  duplicateKey.evidence.push({ ...item, id: 61001 });
  duplicateKey.evidenceOptions.push({ id: 'message:61001:v:1', messageIds: [61001] });
  assert.throws(() => rawChoices(duplicateKey, 'finance', selectors), /ambiguous.*evidence key/i);
  const duplicateBundle = suppliedRequest();
  duplicateBundle.evidenceOptions.push({ id: 'duplicate-singleton', messageIds: [57103] });
  assert.throws(() => rawChoices(duplicateBundle, 'finance', selectors), /ambiguous.*singleton/i);
});

test('E1-F2 structural: chat071 negative cases keep their own named evidence and intentional defects', () => {
  const data = buildDataset();
  for (const [key, mode, primary, finance] of [
    ['m-071-004', 'invalid-distribution', 'm-071-002', 'm-071-003'],
    ['m-071-005', 'missing-answer', 'm-071-003', 'm-071-004'],
    ['m-071-006', 'generic-support', 'm-071-004', 'm-071-005'],
    ['m-071-007', 'extra-answer', 'm-071-005', 'm-071-006'],
  ] as const) {
    const request = structuralSnapshot(data, key);
    const caseSelectors = rawEvidenceFor(key);
    assert.deepEqual(caseSelectors, { primaryMessageKey: primary, financeMessageKey: finance });
    const earlier = data.recording.find((line) => line.t === 'message' && line.message.key === 'm-071-001');
    assert.ok(earlier?.t === 'message');
    request.evidence.unshift({
      id: 91001,
      key: earlier.message.key,
      version: 1,
      sentAt: earlier.message.sentAt,
      text: earlier.message.text,
      media: earlier.message.media,
      replyToId: null,
    });
    request.evidence = request.evidence.map((item, index) => ({ ...item, id: 30001 + index * 917 }));
    const trigger = request.evidence.find((item) => item.key === key);
    assert.ok(trigger);
    request.message.id = trigger.id;
    request.evidenceOptions = request.evidence.map((item) => ({
      id: `message:${item.id}:v:1`,
      messageIds: [item.id],
    }));
    request.evidence.reverse();
    request.evidenceOptions.reverse();
    request.options.reverse();
    assert.equal(MovementRequestSchema.safeParse(request).success, true);
    const envelope = rawChoices(request, mode, caseSelectors);
    const expected = ['movement', 'support:stay', ...request.options.map((item) => `support:${item.id}`)];
    if (mode === 'missing-answer') expected.splice(expected.indexOf(`support:${request.options[0]?.id}`), 1);
    if (mode === 'generic-support') expected.splice(1, expected.length - 1, 'support');
    if (mode === 'extra-answer') expected.push('support:unoffered');
    assert.deepEqual(Object.keys(envelope.answers).sort(), expected.sort());
    assert.equal(envelope.answers.movement?.choice, 'stay');
    for (const [question, answer] of Object.entries(envelope.answers)) {
      const offered =
        question === 'movement'
          ? [...request.options.map((item) => item.id), 'stay', 'review']
          : [...request.evidenceOptions.map((item) => item.id), 'review'];
      assert.deepEqual(Object.keys(answer.probabilities).sort(), offered.sort());
      if (question === 'movement') {
        assert.equal(answer.probabilities.stay, mode === 'invalid-distribution' ? 1.5 : 1);
        continue;
      }
      const option = request.options.find((item) => question === `support:${item.id}`);
      const lane = request.lanes.find((item) => item.id === option?.toLaneId);
      const stage = lane?.stages.find((item) => item.id === option?.toStageId);
      const bundle = request.evidenceOptions.find((item) => item.id === answer.choice);
      assert.ok(bundle);
      assert.deepEqual(
        bundle.messageIds.map((id) => request.evidence.find((item) => item.id === id)?.key),
        [lane?.name === 'Finance' && stage?.name === 'Paid' ? finance : primary],
      );
    }
    assert.equal(envelope.model, null);
    assert.equal(envelope.usage, null);
  }
});
