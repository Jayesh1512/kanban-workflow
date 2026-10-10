import { createHash } from 'node:crypto';
import type { MovementChoice, MovementRequest } from '../src/contracts/index.ts';
import type { RawMode } from './cases.ts';

export interface RawChoiceEnvelope {
  model: null;
  answers: Record<string, MovementChoice & { type: 'choice' }>;
  usage: null;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}
export function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
function choice(options: string[], selected: string, confidence = 0.99): MovementChoice & { type: 'choice' } {
  if (!options.includes(selected)) throw new Error('Fixture choice must belong to its question');
  return {
    type: 'choice',
    choice: selected,
    confidence,
    probabilities: Object.fromEntries(options.map((id) => [id, Number(id === selected)])),
  };
}

/** Build a full N+2 raw fixture from supplied snapshot IDs, never global/assumed DB IDs.
 * E2 passes its actual request here. Static generated raw lines use a documented
 * eval-only structural projection; those numbers must be rebound before runtime use.
 * This produces fixtures, not a provider parser, normalizer, guard or scorer.
 */
export function rawChoices(request: MovementRequest, mode: RawMode): RawChoiceEnvelope {
  if (request.options.length === 0) throw new Error('No-destination has no wire response');
  const movementOptions = [...request.options.map((o) => o.id).sort(), 'stay', 'review'];
  const supportOptions = [...request.evidenceOptions.map((o) => o.id).sort(), 'review'];
  const first = request.evidence[0];
  const second = request.evidence[1];
  if (!first || !second) throw new Error('Independent-support fixture requires two evidence items');
  const firstBundle = request.evidenceOptions.find((o) => o.messageIds.length === 1 && o.messageIds[0] === first.id);
  const secondBundle = request.evidenceOptions.find((o) => o.messageIds.length === 1 && o.messageIds[0] === second.id);
  if (!firstBundle || !secondBundle) throw new Error('Snapshot lacks singleton evidence bundles');
  const finance = request.options.find(
    (o) =>
      request.lanes.find((l) => l.id === o.toLaneId)?.name === 'Finance' &&
      request.lanes.flatMap((l) => l.stages).find((s) => s.id === o.toStageId)?.name === 'Paid',
  );
  if (mode === 'finance' && !finance) throw new Error('Configured Finance/Paid destination is required');
  const movement = mode === 'finance' ? (finance?.id ?? 'review') : mode === 'review' ? 'review' : 'stay';
  const answers: RawChoiceEnvelope['answers'] = {
    movement: choice(movementOptions, movement),
    'support:stay': choice(supportOptions, firstBundle.id),
  };
  for (const option of [...request.options].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const lane = request.lanes.find((l) => l.id === option.toLaneId);
    const stage = lane?.stages.find((s) => s.id === option.toStageId);
    const support = lane?.name === 'Finance' && stage?.name === 'Paid' ? secondBundle.id : firstBundle.id;
    answers[`support:${option.id}`] = choice(supportOptions, support);
  }
  if (mode === 'low') {
    answers.movement = {
      type: 'choice',
      choice: 'stay',
      confidence: 0.1,
      probabilities: Object.fromEntries(
        movementOptions.map((id) => [id, id === 'stay' ? 0.4 : 0.6 / (movementOptions.length - 1)]),
      ),
    };
  }
  if (mode === 'support-review') answers['support:stay'] = choice(supportOptions, 'review');
  if (mode === 'unselected-review') {
    for (const option of request.options) answers[`support:${option.id}`] = choice(supportOptions, 'review', 0.1);
  }
  const movementAnswer = answers.movement;
  if (!movementAnswer) throw new Error('Fixture movement answer is missing');
  if (mode === 'invalid-destination') answers.movement = { ...movementAnswer, choice: 'unoffered:destination' };
  if (mode === 'invalid-distribution') movementAnswer.probabilities.stay = 1.5;
  if (mode === 'missing-answer') delete answers[`support:${request.options[0]?.id}`];
  if (mode === 'generic-support') {
    for (const option of request.options) delete answers[`support:${option.id}`];
    delete answers['support:stay'];
    answers.support = choice(supportOptions, firstBundle.id);
  }
  if (mode === 'extra-answer') answers['support:unoffered'] = choice(supportOptions, firstBundle.id);
  return { model: null, answers, usage: null };
}
