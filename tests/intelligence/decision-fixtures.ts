import { LANES, type JevAnswer } from '../../src/shared/domain.js';
import type { NativeDecisionResponse } from '../../src/intelligence/openai-decisions.js';
import { buildJevRequest } from '../../src/intelligence/jev.js';
import { extractionFixture, inputFixture, responseFixture } from './fixtures.js';
export function nativeDecisionFixture(): NativeDecisionResponse {
  const source = responseFixture() as { answers: Record<string, JevAnswer> }, request = buildJevRequest({ ...inputFixture(), extraction: extractionFixture() }, 'gpt-6-luna');
  return { model: 'gpt-6-luna', usage: { input_tokens: 100, output_tokens: 0 }, answers: Object.entries(source.answers).map(([name, a]) => {
    if (a.type === 'noul') return { name, type: 'predicate' as const, probability: a.noul };
    if (a.type === 'choice') {const label=(value:string)=>name==='lane'&&/^lane_\d+$/.test(value)?LANES[Number(value.slice(5))]!:value;return { name, type: 'choice' as const, choice: label(a.choice), confidence: a.confidence, probabilities: Object.entries(a.probabilities).map(([value, probability]) => ({ value:label(value), probability })) };}
    const q = request.questions[name]!;
    return { name, type: 'score' as const, score: a.score, confidence: a.confidence, probabilities: Object.entries(a.probabilities).map(([value, probability]) => ({ value: Number(value), label: q.type === 'score' ? q.criteria[Number(value)]! : '', probability })) };
  }) };
}
