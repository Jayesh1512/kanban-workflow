import { once } from 'node:events';
import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOpenAIExtractor } from '../src/intelligence/openai.js';
import { createJevAdapter } from '../src/intelligence/jev.js';
import { validateExtraction } from '../src/intelligence/validation.js';
import { corpus, echoExtraction, sourceInput } from './qa-m31-support.js';

let mode: 'echo' | 'gateway403' | 'gatewayNative' | 'gatewayBad' | 'gatewayScoreBad' | 'gatewayScoreRounded' = 'echo';
let calls: Array<{ original: string; path: string; auth: string | undefined; body: Record<string, any> }> = [];
const server = createServer(async (req, res) => {
  const parts: Buffer[] = []; for await (const p of req) parts.push(p);
  const body = JSON.parse(Buffer.concat(parts).toString()); calls.push({ original: '', path: req.url!, auth: req.headers.authorization, body });
  res.setHeader('Content-Type', 'application/json');
  if (mode === 'gateway403') { res.statusCode = 403; res.end(JSON.stringify({ error: { message: 'QA-KEY-DO-NOT-REFLECT', type: 'no_providers_available', param: { name: 'RestrictedModelsError' } } })); return; }
  if (mode === 'echo') {
    const input = JSON.parse(body.input[1].content);
    // Authored stand-in copies source text; it is NOT an LLM or a semantic classifier.
    const output = JSON.stringify(echoExtraction(input));
    res.end(JSON.stringify({ model: body.model, status: 'completed', error: null, incomplete_details: null, output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: output.slice(0, 40) }, { type: 'output_text', text: output.slice(40) }] }], usage: { input_tokens: 11, output_tokens: 9 } })); return;
  }
  const selected: Record<string, string> = { relevance: 'company', company_match: 'ambiguous', workstream: 'Buyer', lane: 'no_change' };
  const answers = Object.fromEntries(Object.entries(body.questions as Record<string, { type: string; criteria: string[] | Record<string,string> }>).map(([id,q]) => {
    if (q.type === 'noul') return [id, { type: 'noul', noul: .95 }];
    const keys = q.type === 'score' ? (q.criteria as string[]).map((_,i) => String(i)) : Object.keys(q.criteria);
    const chosen = q.type === 'score' ? '1' : selected[id];
    const probabilities = Object.fromEntries(keys.map((k) => [k, k === chosen ? 1 : 0]));
    return [id, q.type === 'score' ? { type: 'score', score: 1, confidence: 1, legend: Object.fromEntries((q.criteria as string[]).map((v,i)=>[String(i),v])), probabilities } : { type: 'choice', choice: chosen, confidence: 1, probabilities }];
  }));
  if (mode === 'gatewayScoreBad' || mode === 'gatewayScoreRounded') { answers.urgency.score=mode==='gatewayScoreBad'?1.021:1.019; answers.urgency.probabilities={'0':.25,'1':.5,'2':.25,'3':0}; }
  if (mode === 'gatewayBad') answers.lane = { type: 'choice', choice: 'no_change', confidence: 1, probabilities: { no_change: 1 } };
  res.end(JSON.stringify({ model: 'typesafe-ai/jev', answers, usage: { input_tokens: 12, output_tokens: 10 } }));
});
let address: string;
beforeAll(async () => { server.listen(0,'127.0.0.1'); await once(server,'listening'); address = `http://127.0.0.1:${(server.address() as { port: number }).port}`; });
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve)=>server.close(()=>resolve())); });
const transport: typeof fetch = (endpoint, init) => { const original = String(endpoint); return fetch(`${address}${new URL(original).pathname}`,init).then((r) => { calls.at(-1)!.original = original; return r; }); };
const openai = { provider: 'openai' as const, model: 'gpt-6.1-sol', apiKey: 'QA-KEY-DO-NOT-REFLECT', timeoutMs: 1000, maxAttempts: 1, maxOutputTokens: 4096 };
const gateway = { provider: 'vercel' as const, endpoint: 'https://ai-gateway.vercel.sh/typesafe/v1/systemone', model: 'typesafe-ai/jev', apiKey: 'QA-KEY-DO-NOT-REFLECT', timeoutMs: 1000, maxAttempts: 5 };

describe('independent corpus transport/source integrity, NOT multilingual model quality', () => {
  it.each(corpus.cases.map((c)=>[c.case_id,c.language] as const))('%s (%s) preserves original text, source IDs and no-approval boundary through strict Responses adapter', async (id) => {
    calls = []; mode = 'echo'; const input = sourceInput(id);
    const result = await createOpenAIExtractor(openai,{ fetch: transport }).extract(input);
    if (input.messages[0]!.deletedAt) { expect(result).toMatchObject({ ok: false, code: 'invalid_response' }); return; }
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.value.facts[0]!.text).toBe(input.messages[0]!.text);
    expect(result.value.evidenceIds).toEqual(input.evidence.map((e)=>e.id));
    expect(calls[0]).toMatchObject({ original: 'https://api.openai.com/v1/responses', path: '/v1/responses', auth: 'Bearer QA-KEY-DO-NOT-REFLECT', body: { store: false, text: { format: { strict: true, type: 'json_schema' } } } });
    const payload = JSON.parse(calls[0]!.body.input[1].content);
    expect(payload.messages[0]).toEqual(input.messages[0]);
    expect(Object.keys(result.value)).not.toContain('lane');
    expect(corpus.cases.find((c)=>c.case_id===id)!.expected.board_must_remain_unchanged_before_approval).toBe(true);
  });
  it('uses real native HTTP with Gateway path/bearer, typed diagnostics; rejects incomplete distributions', async () => {
    const input = sourceInput('rel-024'), extraction = echoExtraction(input); mode = 'gatewayNative'; calls=[];
    const result = await createJevAdapter(gateway,{ fetch: transport }).decide({ ...input, extraction });
    expect(result).toMatchObject({ ok: true, value: { companyMatch: { outcome: 'ambiguous' }, lane: { outcome: 'no_change' }, diagnostics: { answers: { supported: { type: 'noul', noul: .95 } } } } });
    expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ original: gateway.endpoint, path: '/typesafe/v1/systemone', auth: 'Bearer QA-KEY-DO-NOT-REFLECT' });
    mode='gatewayBad'; expect(await createJevAdapter(gateway,{ fetch: transport }).decide({ ...input, extraction })).toMatchObject({ ok: false, code: 'invalid_response' });
  });
  it.each([['gatewayScoreRounded',true],['gatewayScoreBad',false]] as const)('checks weighted native score rounding: %s', async (selected,accepted)=> {
    mode=selected; const input=sourceInput('rel-024'); const result=await createJevAdapter(gateway,{fetch:transport}).decide({...input,extraction:echoExtraction(input)});
    expect(result.ok).toBe(accepted); if (!accepted) expect(result).toMatchObject({code:'invalid_response'});
  });
  it('surfaces entitlement once without fallback, reflected secret or fabricated decision', async () => {
    mode='gateway403'; calls=[]; const input=sourceInput('rel-008'); const adapter=createJevAdapter(gateway,{ fetch: transport });
    const result=await adapter.decide({ ...input, extraction: echoExtraction(input) });
    expect(result).toMatchObject({ ok:false,code:'entitlement',retryable:false,retryAt:null }); expect(result).not.toHaveProperty('value');
    expect(calls).toHaveLength(1); expect(JSON.stringify(result)).not.toContain(gateway.apiKey);
    expect(await adapter.status()).toMatchObject({ state:'unavailable',code:'entitlement' });
  });
});

describe('independent identity/precision safety regressions (known architect P1s)', () => {
  function forwarded() {
    const input=sourceInput('rel-026'), sender=input.messages[0]!.sender;
    sender.id='990000001'; sender.names=['Maya Shah']; sender.usernames=['maya']; sender.visiblePhones=['+15550000001'];
    input.messages[0]!.senderId=sender.id;
    input.messages[0]!.forward={ isForwarded:true,sourceKind:'forwarded',originName:'Noor Mehta',originDate:input.messages[0]!.sentAt,originMessageId:99, originPeer:{ ...sender,id:'990000002',names:['Noor Mehta'],usernames:['noor'],visiblePhones:['+15550000002'] } };
    const x=echoExtraction(input); x.contacts=[{ telegramUserIds:['990000002'],names:['Noor Mehta'],usernames:['noor'],phones:['+15550000002'],emails:[],affiliation:'external',roles:[],evidenceIds:x.evidenceIds }];
    return {input,x};
  }
  it('accepts origin user profile details from origin snapshot rather than outer forwarder',()=> { const {input,x}=forwarded(); expect(()=>validateExtraction(x,input)).not.toThrow(); });
  it('rejects assigning outer forwarder phone to original author',()=> { const {input,x}=forwarded(); x.contacts[0]!.phones=['+15550000001']; expect(()=>validateExtraction(x,input)).toThrow(); });
  it.each(['names','usernames'] as const)('rejects unsourced contact %s', (field)=> { const {input,x}=forwarded(); x.contacts[0]!.phones=[]; x.contacts[0]![field]=['Fabricated_Never_Visible']; expect(()=>validateExtraction(x,input)).toThrow(); });
  it('does not infer internal affiliation from AntSeed mentioned in an external author statement',()=> {
    const input=sourceInput('rel-026'); input.messages[0]!.text='Noor from Cedar Relay here. AntSeed is our vendor, not my employer.'; input.evidence[0]!.excerpt=input.messages[0]!.text;
    const x=echoExtraction(input); x.contacts=[{ telegramUserIds:['990000002'],names:['Noor Mehta'],usernames:[],phones:[],emails:[],affiliation:'internal',roles:[],evidenceIds:x.evidenceIds }]; expect(()=>validateExtraction(x,input)).toThrow();
  });
  it('rejects a hidden forwarded author being identified as the forwarding user',()=> { const input=sourceInput('rel-022'),x=echoExtraction(input); x.contacts=[{ telegramUserIds:[input.messages[0]!.senderId!],names:[],usernames:[],phones:[],emails:[],affiliation:'unknown',roles:[],evidenceIds:x.evidenceIds }]; expect(()=>validateExtraction(x,input)).toThrow(); });
  it.each(['day-as-instant','invented-source-time','ambiguous-kal'] as const)('rejects %s even when provider declares precise output', (mode)=> {
    const input=sourceInput(mode==='ambiguous-kal'?'rel-031':'rel-035'),x=echoExtraction(input);
    x.dates=[{ kind:'follow_up',originalText:mode==='invented-source-time'?'tomorrow at 10:00 IST':mode==='ambiguous-kal'?'कल दस बजे कॉल।':'tomorrow',relativeTo:input.messages[0]!.sentAt,timezone:'Asia/Kolkata',localDate:null,resolvedAt:'1999-01-01T00:00:00Z',precision:'instant',ambiguous:false,evidenceIds:x.evidenceIds }];
    expect(()=>validateExtraction(x,input)).toThrow();
  });
  it('accepts the corpus explicit time and preserves original message anchor after delayed import',()=> {
    const input=sourceInput('rel-029'),x=echoExtraction(input); x.dates=[{ kind:'follow_up',originalText:'tomorrow at 10:00 IST',relativeTo:'2026-10-17T18:29:00Z',timezone:'Asia/Kolkata',localDate:null,resolvedAt:'2026-10-18T04:30:00Z',precision:'instant',ambiguous:false,evidenceIds:x.evidenceIds }]; expect(validateExtraction(x,input).dates[0]!.resolvedAt).toBe('2026-10-18T04:30:00Z');
  });
  it.each([
    ['rel-029','2026-10-18T04:30:00Z'],
    ['rel-030','2026-10-19T04:30:00Z'],
    ['rel-032','2026-10-18T04:30:00Z'],
  ])('%s accepts the independently specified explicit-time corpus commitment', (id,instant)=> {
    const input=sourceInput(id!),x=echoExtraction(input);
    x.dates=[{ kind:'follow_up',originalText:input.messages[0]!.text,relativeTo:input.messages[0]!.sentAt,timezone:'Asia/Kolkata',localDate:null,resolvedAt:instant!,precision:'instant',ambiguous:false,evidenceIds:x.evidenceIds }];
    expect(validateExtraction(x,input).dates[0]!.resolvedAt).toBe(instant);
  });

  it.each(['rel-030','rel-032'])('%s still rejects an arbitrary1999 instant after multilingual clock support', (id)=> {
    const input=sourceInput(id),x=echoExtraction(input);
    x.dates=[{ kind:'follow_up',originalText:input.messages[0]!.text,relativeTo:input.messages[0]!.sentAt,timezone:'Asia/Kolkata',localDate:null,resolvedAt:'1999-01-01T00:00:00Z',precision:'instant',ambiguous:false,evidenceIds:x.evidenceIds }];
    expect(()=>validateExtraction(x,input)).toThrow();
  });

});
