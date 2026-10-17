import { z } from 'zod';
import { LANES, type AnalysisInput, type Extraction, type JevDecision, type Json } from '../shared/domain.js';
import type { JevPort, ProviderResult, RuntimeConfig } from '../shared/ports.js';
import { buildJevRequest, decisionFromAnswers, validateAnswers } from './jev.js';
import { ProviderHttp, type HttpOptions } from './http.js';
import { usageProjection } from './openai.js';
import { validateExtraction } from './validation.js';

export const OPENAI_DECISIONS_VERSION = 'openai.decisions.antseed.v3';
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
    if (q.type === 'choice') return { name, type: 'choice' as const, instructions: q.instructions, choices: Object.entries(q.criteria).map(([value, description]) => ({ value:name==='lane'&&/^lane_\d+$/.test(value)?LANES[Number(value.slice(5))]!:value, description })) };
    return { name, type: 'score' as const, instructions: q.instructions, levels: q.criteria.map(label => ({ label })) };
  });
  // Keep original text and provenance, but put the direct conversation before
  // directory/SQL scaffolding. Large evidence DTOs otherwise repeat each quote
  // and obscure the short recipient response being classified.
  const cited=new Set(input.extraction.evidenceIds);
  const messages=input.messages.filter(m=>!m.deletedAt&&input.evidence.some(e=>cited.has(e.id)&&!e.invalidatedAt&&e.chatId===m.chatId&&e.messageId===m.id&&e.messageVersion===m.version)).sort((a,b)=>Date.parse(a.sentAt)-Date.parse(b.sentAt)||a.id-b.id);
  const conversation=messages.map(m=>({messageId:m.id,sentAt:m.sentAt,author:m.senderId===input.accountSelfId?'AntSeed connected account':input.extraction.contacts.some(c=>c.affiliation==='internal'&&c.telegramUserIds.includes(m.senderId??''))?'AntSeed teammate':'Other participant',senderId:m.senderId,forwarded:m.forward.isForwarded,text:m.text}));
  return { model: 'gpt-6-luna' as const, input: JSON.stringify({state:{currentLane:rubric.state.currentLane,conversation,accountSelfId:input.accountSelfId??null,outreach:rubric.state.outreach,chat:input.chat,ticket:input.ticket,companies:input.companies,extraction:input.extraction,stagePolicy:rubric.state.stagePolicy,messages:input.messages,rubricVersion:OPENAI_DECISIONS_VERSION}}), questions };
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
      const compatibilityValue=(value:string)=>{
        if(name!=='lane')return value;
        const index=LANES.findIndex(lane=>lane===value);
        if(index>=0)return 'lane_'+index;
        if(value==='no_change'||value==='uncertain')return value;
        throw new Error('Invalid native lane label');
      };
      answers[name] = { type: 'choice', choice: compatibilityValue(a.choice), confidence: a.confidence, probabilities: Object.fromEntries(a.probabilities.map(p => [compatibilityValue(p.value), p.probability])) };
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
