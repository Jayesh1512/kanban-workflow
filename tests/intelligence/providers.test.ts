import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOpenAIExtractor } from '../../src/intelligence/openai.js';
import { buildJevRequest, createJevAdapter, validateAnswers } from '../../src/intelligence/jev.js';
import { validateExtraction } from '../../src/intelligence/validation.js';
import { extractionFixture, inputFixture, responseFixture } from './fixtures.js';

let handler: (request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>) => void;
const requests: Array<{ url: string | undefined; body: Record<string, unknown>; authorization: string | undefined }> = [];
const server = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push({ url: req.url, body, authorization: req.headers.authorization }); handler(req, res, body);
});
let address: string;
beforeAll(async () => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); address = `http://127.0.0.1:${(server.address() as { port: number }).port}`; });
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
// Transport redirect only: the production adapter still constructs its real endpoint and native fetch performs real HTTP.
const localFetch: typeof fetch = (url, init) => fetch(`${address}${new URL(String(url)).pathname}`, init);
const config = { provider: 'openai' as const, model: 'gpt-6.1-sol', apiKey: 'synthetic-test-key', timeoutMs: 1000, maxAttempts: 2, maxOutputTokens: 4096 };
const jevConfig = { provider: 'vercel' as const, endpoint: 'https://ai-gateway.vercel.sh/typesafe/v1/systemone', model: 'typesafe-ai/jev', apiKey: 'synthetic-gateway-key', timeoutMs: 1000, maxAttempts: 1 };
const reply = (res: ServerResponse, data: unknown, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json', 'x-request-id': 'synthetic-request' }); res.end(JSON.stringify(data)); };

describe('real HTTP adapter paths against local documented-contract stand-ins (no live credentials)', () => {
  it('sends Responses strict schema, skips reasoning items and returns bounded provenance', async () => {
    requests.length = 0;
    handler = (_, res) => reply(res, { model: config.model, status: 'completed', error: null, incomplete_details: null,
      output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(extractionFixture()) }] }], usage: { input_tokens: 100, output_tokens: 30, ignored: 'not retained' } });
    const result = await createOpenAIExtractor(config, { fetch: localFetch }).extract(inputFixture());
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.value).toEqual(extractionFixture()); expect(result.provenance.usage).toEqual({ input_tokens: 100, output_tokens: 30 });
    expect(requests[0]!.url).toBe('/v1/responses'); expect(requests[0]!.authorization).toBe('Bearer synthetic-test-key');
    expect(requests[0]!.body).toMatchObject({ model: config.model, store: false, reasoning: { effort: 'low' }, text: { format: { strict: true, type: 'json_schema' } } });
  });
  it.each(['incomplete', 'refusal', 'invalid_json', 'foreign_evidence'])('rejects %s extraction', async (mode) => {
    const extraction = extractionFixture(); if (mode === 'foreign_evidence') extraction.evidenceIds = ['00000000-0000-4000-8000-999999999999'];
    handler = (_, res) => reply(res, { model: config.model, status: mode === 'incomplete' ? 'incomplete' : 'completed', error: null, incomplete_details: mode === 'incomplete' ? { reason: 'max_output_tokens' } : null,
      output: [{ type: 'message', content: [{ type: mode === 'refusal' ? 'refusal' : 'output_text', text: mode === 'invalid_json' ? '{' : JSON.stringify(extraction) }] }] });
    expect(await createOpenAIExtractor(config, { fetch: localFetch }).extract(inputFixture())).toMatchObject({ ok: false, code: 'invalid_response' });
  });
  it('records omission of an unsourced optional alias without a second model call, retaining valid facts and identity',async()=>{
    requests.length=0;const extraction=extractionFixture();extraction.contacts[0]!.names.push('Invented unseen alias');
    handler=(_,res)=>reply(res,{model:config.model,status:'completed',error:null,incomplete_details:null,output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(extraction)}]}]});
    const result=await createOpenAIExtractor(config,{fetch:localFetch}).extract(inputFixture());expect(result).toMatchObject({ok:true,provenance:{validation:{omittedContactNames:1}}});if(result.ok)expect(result.value).toEqual(extractionFixture());expect(requests).toHaveLength(1);
  });
  it('records omitted optional company attributes while returning only source-validated values',async()=>{
    requests.length=0;const extraction=extractionFixture();extraction.companies[0]!.aliases.push('Invented brand expansion');extraction.companies[0]!.domains.push('invented.example');
    handler=(_,res)=>reply(res,{model:config.model,status:'completed',error:null,incomplete_details:null,output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(extraction)}]}]});
    const result=await createOpenAIExtractor(config,{fetch:localFetch}).extract(inputFixture());expect(result).toMatchObject({ok:true,provenance:{validation:{omittedCompanyAttributes:2}}});if(result.ok)expect(result.value).toEqual(extractionFixture());expect(requests).toHaveLength(1);
  });
  it('sends Vercel systemone typed questions and keeps native diagnostics', async () => {
    requests.length = 0; handler = (_, res) => reply(res, responseFixture());
    const result = await createJevAdapter(jevConfig, { fetch: localFetch }).decide({ ...inputFixture(), extraction: extractionFixture() });
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.value).toMatchObject({ relevance: 'company', companyMatch: { outcome: 'new_company' }, lane: { outcome: 'no_change' }, workstream: 'Buyer' });
    expect(result.value.diagnostics.answers.supported).toEqual({ type: 'noul', noul: 0.98 });
    expect(requests[0]!.url).toBe('/typesafe/v1/systemone'); expect(requests[0]!.authorization).toBe('Bearer synthetic-gateway-key');
    expect(requests[0]!.body).toMatchObject({ model: jevConfig.model, questions: { supported: { type: 'noul' }, urgency: { type: 'score' } } });
    expect(requests[0]!.body).not.toHaveProperty('messages');
  });
  it('surfaces known Gateway 403 once, sanitizes body and never falls back', async () => {
    requests.length = 0; handler = (_, res) => reply(res, { error: { type: 'no_providers_available', param: { name: 'RestrictedModelsError' }, message: 'synthetic-gateway-key secret reflected' } }, 403);
    const adapter = createJevAdapter({ ...jevConfig, maxAttempts: 5 }, { fetch: localFetch });
    const result = await adapter.decide({ ...inputFixture(), extraction: extractionFixture() });
    expect(result).toMatchObject({ ok: false, code: 'entitlement', retryable: false }); expect(JSON.stringify(result)).not.toContain('synthetic-gateway-key'); expect(requests).toHaveLength(1);
    expect(await adapter.status()).toMatchObject({ state: 'unavailable', code: 'entitlement' });
  });
  it('bounds retries and respects long Retry-After by returning work to the queue', async () => {
    requests.length = 0; handler = (_, res) => { res.setHeader('Retry-After', '120'); reply(res, { error: 'busy' }, 429); };
    const result = await createJevAdapter({ ...jevConfig, maxAttempts: 3 }, { fetch: localFetch }).decide({ ...inputFixture(), extraction: extractionFixture() });
    expect(result).toMatchObject({ ok: false, code: 'rate_limited', retryable: true }); expect(requests).toHaveLength(1);
    requests.length = 0; handler = (_, res) => reply(res, {}, 503);
    await createJevAdapter({ ...jevConfig, maxAttempts: 2 }, { fetch: localFetch, sleep: async () => {} }).decide({ ...inputFixture(), extraction: extractionFixture() }); expect(requests).toHaveLength(2);
  });
  it('times out actual hanging HTTP and rejects non-JSON errors without reflected text', async () => {
    handler = () => {};
    expect(await createJevAdapter({ ...jevConfig, timeoutMs: 30 }, { fetch: localFetch }).decide({ ...inputFixture(), extraction: extractionFixture() })).toMatchObject({ ok: false, code: 'timeout' });
    handler = (_, res) => { res.writeHead(502, { 'Content-Type': 'text/html' }); res.end('<html>synthetic-gateway-key</html>'); };
    const result = await createJevAdapter(jevConfig, { fetch: localFetch }).decide({ ...inputFixture(), extraction: extractionFixture() }); expect(result).toMatchObject({ ok: false, code: 'unavailable' }); expect(JSON.stringify(result)).not.toContain('synthetic-gateway-key');
  });
  it('does not send excluded/control content or use a direct TypeSafe endpoint', async () => {
    requests.length = 0; const input = inputFixture(); input.chat.isControl = true;
    expect((await createOpenAIExtractor(config, { fetch: localFetch }).extract(input)).ok).toBe(false);
    expect((await createJevAdapter(jevConfig, { fetch: localFetch }).decide({ ...input, extraction: extractionFixture() })).ok).toBe(false);
    expect((await createJevAdapter({ ...jevConfig, endpoint: 'https://api.typesafe.ai/v1/systemone' }, { fetch: localFetch }).decide({ ...inputFixture(), extraction: extractionFixture() })).ok).toBe(false);
    expect(requests).toHaveLength(0);
  });
});

describe('semantic validation beyond provider schemas', () => {
  it('requires null for an actor without a pre-existing contact UUID (real-probe regression)', () => {
    const extraction = extractionFixture(); extraction.facts[0]!.actor.contactId = '00000000-0000-4000-8000-000000000009';
    expect(() => validateExtraction(extraction, inputFixture())).toThrow('Unknown actor contact');
  });
  it.each([
    ['Hindi', 'मैं Cedar Labs में CTO हूँ। AntSeed कल नोट्स भेजेगा।', 'कल', true],
    ['Hinglish', 'Main Cedar Labs ka CTO hoon. AntSeed kal notes bhejunga.', 'kal notes bhejunga', false],
  ])('preserves %s evidence and source-relative date ambiguity', (_, source, phrase, ambiguous) => {
    const input = inputFixture(); input.messages[0]!.text = source; input.evidence[0]!.excerpt = source;
    const extraction = extractionFixture(); const date = extraction.facts[0]!.dates[0]!; date.originalText = phrase; date.ambiguous = ambiguous;
    if (ambiguous) { date.localDate = null; date.precision = 'unresolved'; }
    expect(validateExtraction(extraction, input).facts[0]!.dates[0]).toMatchObject({ originalText: phrase, ambiguous, localDate: ambiguous ? null : '2026-10-18' });
  });
  it('never binds a forwarded hidden-author role to the forwarding sender', () => {
    const input = inputFixture(); input.messages[0]!.forward = { isForwarded: true, sourceKind: 'forwarded', originPeer: null, originName: null, originDate: null, originMessageId: null };
    expect(() => validateExtraction(extractionFixture(), input)).toThrow('Contact identity');
  });
  it('rejects invented company aliases and identifiers despite otherwise valid company evidence', () => {
    const extraction = extractionFixture(); extraction.companies[0]!.buyerIds = ['invented_buyer_id'];
    expect(() => validateExtraction(extraction, inputFixture())).toThrow('Company attribute');
  });
  it.each(['date', 'phone', 'role', 'id', 'anchor', 'deleted', 'excerpt'])('rejects invented/stale %s evidence', (mode) => {
    const input = inputFixture(); const extraction = extractionFixture();
    if (mode === 'date') extraction.facts[0]!.dates[0]!.localDate = '2026-10-17';
    if (mode === 'phone') extraction.contacts[0]!.phones = ['+123456'];
    if (mode === 'role') extraction.contacts[0]!.roles[0]!.role = 'CEO';
    if (mode === 'id') input.messages[0]!.sender.kind = 'anonymous';
    if (mode === 'anchor') extraction.facts[0]!.dates[0]!.relativeTo = '2026-10-17T00:00:00Z';
    if (mode === 'deleted') input.messages[0]!.deletedAt = '2026-10-17T00:00:00Z';
    if (mode === 'excerpt') input.evidence[0]!.excerpt = 'fabricated quote';
    expect(() => validateExtraction(extraction, input)).toThrow();
  });
  it.each(['boolean', 'missing', 'range', 'fallback', 'empty_distribution'])('rejects invalid Jev %s shape', (mode) => {
    const raw = responseFixture() as { model: string; answers: Record<string, unknown> };
    if (mode === 'boolean') raw.answers.supported = { type: 'boolean', probability: 1 };
    if (mode === 'missing') delete raw.answers.lane;
    if (mode === 'range') raw.answers.supported = { type: 'noul', noul: 1.1 };
    if (mode === 'fallback') raw.model = 'openai/gpt-6.1-sol';
    if (mode === 'empty_distribution') raw.answers.company_match = { type: 'choice', choice: 'new_company', confidence: 0, probabilities: {} };
    expect(() => validateAnswers(raw, buildJevRequest({ ...inputFixture(), extraction: extractionFixture() }, jevConfig.model))).toThrow();
  });
});

// The native score contract defines score as the probability-weighted level mean.
it('rejects contradictory native urgency scores while allowing small numeric rounding', () => {
  const input = inputFixture(), extraction = extractionFixture(); const request = buildJevRequest({ ...input, extraction }, jevConfig.model); const raw = responseFixture(input, extraction);
  raw.answers.urgency!.score = 3; expect(() => validateAnswers(raw, request)).toThrow('weighted distribution');
  raw.answers.urgency!.probabilities = { '0': 0, '1': 0.5, '2': 0.5, '3': 0 }; raw.answers.urgency!.score = 1.5; expect(validateAnswers(raw, request).answers.urgency).toMatchObject({ score: 1.5 });
  raw.answers.urgency!.score = 1.501; expect(() => validateAnswers(raw, request)).not.toThrow();
});
