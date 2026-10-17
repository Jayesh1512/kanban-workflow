import { writeFile } from 'node:fs/promises';
import { loadRuntimeConfig } from '../../src/platform/config.js';
import { createOpenAIDecisions } from '../../src/intelligence/openai-decisions.js';
import { laneScenarios, scenarioInput } from './lane-scenarios.js';

// Explicit opt-in, synthetic conversations only. No DB, Telegram or board calls.
if(!process.env['LANE_EVAL_OUTPUT'])throw new Error('Explicit LANE_EVAL_OUTPUT is required');
const config=await loadRuntimeConfig({...process.env,MOVEMENT_PROVIDER:'openai',JEV_ENDPOINT:'https://api.openai.com/v1/decisions',JEV_MODEL:'gpt-6-luna'});
const provider=createOpenAIDecisions({...config.jev,timeoutMs:20000,maxAttempts:1});
const only=new Set(process.env['LANE_EVAL_CASES']?.split(',').filter(Boolean));
const selected=laneScenarios.filter(s=>!only.size||only.has(s.id));
const results:unknown[]=[];
for(let i=0;i<selected.length;i+=2)await Promise.all(selected.slice(i,i+2).map(async scenario=>{
  const result=await provider.decide(scenarioInput(scenario));
  const actual=result.ok&&result.value.lane.outcome==='propose'?result.value.lane.targetLane:null;
  const pass=result.ok&&actual===scenario.target;
  const entry={id:scenario.id,from:scenario.from,expected:scenario.target,actual,pass,...(result.ok?{outcome:result.value.lane.outcome,diagnostics:result.value.diagnostics,provenance:result.provenance}:{error:result.code})};
  results.push(entry);console.log(JSON.stringify({id:scenario.id,pass,expected:scenario.target,actual,...(!result.ok?{error:result.code}:{})}));
}));
await writeFile(process.env['LANE_EVAL_OUTPUT'],JSON.stringify({at:new Date().toISOString(),synthetic:true,model:'gpt-6-luna',results},null,2),{mode:0o600});
console.log(JSON.stringify({total:results.length,passed:results.filter(r=>(r as {pass:boolean}).pass).length}));
if(results.some(r=>!(r as {pass:boolean}).pass))process.exitCode=1;
