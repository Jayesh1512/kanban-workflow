import { z } from 'zod';
import type { AnalysisInput, Extraction, JevDecision, Json } from '../shared/domain.js';
import type { JevPort, ProviderResult, RuntimeConfig } from '../shared/ports.js';
import { buildJevRequest, decisionFromAnswers, validateAnswers } from './jev.js';
import { ProviderHttp, type HttpOptions } from './http.js';
import { usageProjection } from './openai.js';
import { validateExtraction } from './validation.js';

export const OPENAI_DECISIONS_VERSION = 'openai.decisions.antseed.v2';
const probability = z.number().min(0).max(1);
const nativeResponse = z.object({ model: z.literal('gpt-6-luna'), usage: z.unknown().optional(), answers: z.array(z.discriminatedUnion('type', [
  z.object({ type: z.literal('predicate'), name: z.string(), probability }),
  z.object({ type: z.literal('choice'), name: z.string(), choice: z.string(), confidence: probability, probabilities: z.array(z.object({ value: z.string(), probability })) }),
  z.object({ type: z.literal('score'), name: z.string(), score: z.number().finite(), confidence: probability, probabilities: z.array(z.object({ value: z.number().int(), label: z.string(), probability })) }),
  z.object({ type: z.literal('refusal'), name: z.string().nullable() }),
])) });

export type NativeDecisionResponse = z.infer<typeof nativeResponse>;

export function buildOpenAIDecisionsRequest(input: AnalysisInput & { extraction: Extraction }) {
  const rubric = buildJevRequest(input, 'gpt-6-luna');
  const questions = Object.entries(rubric.questions).map(([name, q]) => {
    if (q.type === 'noul') return { name, type: 'predicate' as const, instructions: q.instructions };
    if (q.type === 'choice') return { name, type: 'choice' as const, instructions: q.instructions, choices: Object.entries(q.criteria).map(([value, description]) => ({ value, description })) };
    return { name, type: 'score' as const, instructions: q.instructions, levels: q.criteria.map(label => ({ label })) };
  });
  return { model: 'gpt-6-luna' as const, input: JSON.stringify({ state: rubric.state }), questions };
}

export function parseOpenAIDecisions(raw: unknown, input: AnalysisInput & { extraction: Extraction }): JevDecision {
  const response = nativeResponse.parse(raw), rubric = buildJevRequest(input, 'gpt-6-luna');
  const expected = Object.entries(rubric.questions);
  if (response.answers.length !== expected.length) throw new Error('Missing or extra decision answers');
  const answers: Record<string, unknown> = {};
  for (let i = 0; i < expected.length; i++) {
    const [name, q] = expected[i]!, a = response.answers[i]!;
    if (a.type === 'refusal') throw new Error('Decision model refused; no recommendation accepted');
    if (a.name !== name || Object.hasOwn(answers, name)) throw new Error('Wrong decision answer identity/order');
    if (q.type === 'noul' && a.type === 'predicate') answers[name] = { type: 'noul', noul: a.probability };
    else if (q.type === 'choice' && a.type === 'choice') {
      if (new Set(a.probabilities.map(p => p.value)).size !== a.probabilities.length) throw new Error('Duplicate choice probabilities');
      answers[name] = { type: 'choice', choice: a.choice, confidence: a.confidence, probabilities: Object.fromEntries(a.probabilities.map(p => [p.value, p.probability])) };
    } else if (q.type === 'score' && a.type === 'score') {
      if (new Set(a.probabilities.map(p => p.value)).size !== a.probabilities.length || a.probabilities.some(p => q.criteria[p.value] !== p.label)) throw new Error('Invalid score labels/levels');
      answers[name] = { type: 'score', score: a.score, confidence: a.confidence, probabilities: Object.fromEntries(a.probabilities.map(p => [String(p.value), p.probability])), legend: Object.fromEntries(a.probabilities.map(p => [String(p.value), p.label])) };
    } else throw new Error('Wrong decision answer primitive');
  }
  const validated = validateAnswers({ model: response.model, answers }, rubric);
  const result = decisionFromAnswers(input, validated, OPENAI_DECISIONS_VERSION);
  // Preserve native fields; compatibility answers are a structural conversion,
  // never model-generated confidence or invented probabilities.
  result.diagnostics.native = { provider: 'openai', answers: response.answers } as Json;
  return result;
}

export function createOpenAIDecisions(config: RuntimeConfig['jev'], options: HttpOptions = {}): JevPort {
  const http = new ProviderHttp(config, options);
  return {
    async status() { const current = http.status(); return { ...current, detail: `OpenAI Decisions · gpt-6-luna${current.code ? ' · ' + current.code.replaceAll('_', ' ') : ''}` }; },
    async decide(input, signal): Promise<ProviderResult<JevDecision>> {
      if (config.provider !== 'openai' || config.endpoint !== 'https://api.openai.com/v1/decisions' || config.model !== 'gpt-6-luna') return http.invalid();
      try { validateExtraction(input.extraction, input); } catch { return http.invalid(); }
      const result = await http.post(config.endpoint, buildOpenAIDecisionsRequest(input), signal); if (!result.ok) return result;
      try {
        const value = parseOpenAIDecisions(result.data, input);
        return { ok: true, value, provenance: { provider: 'openai', model: config.model, requestId: result.requestId, schemaVersion: OPENAI_DECISIONS_VERSION, completedAt: http.clock.now().toISOString(), usage: usageProjection((result.data as { usage?: unknown }).usage) } };
      } catch { return http.invalid(); }
    },
  };
}
