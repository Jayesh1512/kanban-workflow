import { describe, expect, it } from 'vitest';
import { LANES } from '../../src/shared/domain.js';
import { buildOpenAIDecisionsRequest, parseOpenAIDecisions } from '../../src/intelligence/openai-decisions.js';
import { validateExtraction } from '../../src/intelligence/validation.js';
import { laneScenarios, scenarioInput } from './lane-scenarios.js';
import { recommendation } from './outbound-fixtures.js';
import { strongChoice, strongLaneChoice } from '../../src/intelligence/jev.js';

describe('all-lane policy source and confidence boundaries (authored responses, not model quality)',()=>{
  it.each(laneScenarios)('$id has valid source-bound extraction and all six stage definitions',scenario=>{
    const input=scenarioInput(scenario);expect(()=>validateExtraction(input.extraction,input)).not.toThrow();
    const request=buildOpenAIDecisionsRequest(input),state=JSON.parse(request.input).state;
    expect(state.currentLane).toBe(scenario.from);
    for(const lane of LANES)expect(state.stagePolicy).toContain(lane);
    expect(request.questions.find(q=>q.name==='supported')?.instructions).toContain('does NOT require approval');
  });
  it.each(laneScenarios.filter(s=>s.target))('$id interprets a supported native recommendation as propose only',scenario=>{
    const input=scenarioInput(scenario),raw=recommendation();
    const lane=raw.answers.find(a=>a.name==='lane')!;if(lane.type==='choice'){const target=scenario.target!;lane.choice=target;for(const p of lane.probabilities)p.probability=p.value===target?1:0;}
    const before=structuredClone(input.ticket);expect(parseOpenAIDecisions(raw,input).lane).toMatchObject({outcome:'propose',targetLane:scenario.target});expect(input.ticket).toEqual(before);
  });
  it.each(['old-social-reply','internal-interest','forwarded-live-claim','deleted-interest','uncited-interest','outbound-only','own-followup'])('%s cannot bypass source attribution even with an overconfident model',id=>{
    const input=scenarioInput(laneScenarios.find(s=>s.id===id)!);expect(parseOpenAIDecisions(recommendation(),input).lane.outcome).toBe('no_change');
  });
  it('explains low confidence and evidence rejection without removing either threshold',()=>{
    const input=scenarioInput(laneScenarios.find(s=>s.id==='exact-short-interest')!),raw=recommendation();
    const lane=raw.answers.find(a=>a.name==='lane')!;if(lane.type==='choice'){lane.confidence=0.81;for(const p of lane.probabilities)p.probability=p.value==='Work in progress'?0.83:p.value==='no_change'?0.17:0;}
    const support=raw.answers.find(a=>a.name==='supported')!;if(support.type==='predicate')support.probability=0;
    const result=parseOpenAIDecisions(raw,input);expect(result.lane.outcome).toBe('uncertain');expect(result.lane.reason).toContain('confidence threshold');expect(result.lane.reason).toContain('support threshold');
  });
  it('uses a separate native suggestion threshold, retaining strict identity and independent source support',()=>{
    const input=scenarioInput(laneScenarios.find(s=>s.id==='exact-short-interest')!),raw=recommendation();
    const lane=raw.answers.find(a=>a.name==='lane')!;if(lane.type!=='choice')throw new Error('fixture');
    lane.confidence=0.85;for(const p of lane.probabilities)p.probability=p.value==='Work in progress'?0.88:p.value==='no_change'?0.12:0;
    const accepted=parseOpenAIDecisions(raw,input);expect(accepted.lane.outcome).toBe('propose');
    expect(strongLaneChoice(accepted.diagnostics.answers.lane)).toBe(true);expect(strongChoice(accepted.diagnostics.answers.lane)).toBe(false);
    const support=raw.answers.find(a=>a.name==='supported')!;if(support.type==='predicate')support.probability=0.89;
    expect(parseOpenAIDecisions(raw,input).lane.outcome).toBe('uncertain');
  });
});
