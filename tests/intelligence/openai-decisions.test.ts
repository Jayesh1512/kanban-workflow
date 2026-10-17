import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildOpenAIDecisionsRequest, createOpenAIDecisions, OPENAI_DECISIONS_VERSION, parseOpenAIDecisions } from '../../src/intelligence/openai-decisions.js';
import { extractionFixture, inputFixture } from './fixtures.js';
import { nativeDecisionFixture } from './decision-fixtures.js';
const input = () => ({ ...inputFixture(), extraction: extractionFixture() });
const config = { provider: 'openai' as const, model: 'gpt-6-luna', endpoint: 'https://api.openai.com/v1/decisions', apiKey: 'synthetic-native-key', timeoutMs: 1000, maxAttempts: 1 };
let url: string, mode = 'success'; const requests: { path: string | undefined; authorization: string | undefined; body: unknown }[] = [];
const server = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  requests.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
  if (mode === 'hang') return;
  res.setHeader('Content-Type', 'application/json'); res.setHeader('x-request-id', 'native-decision-test');
  res.statusCode = mode === 'credit' ? 402 : mode === 'unavailable' ? 503 : 200;
  res.end(JSON.stringify(mode === 'success' ? nativeDecisionFixture() : { error: { message: 'synthetic-native-key reflected' } }));
});
beforeAll(async () => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); url = `http://127.0.0.1:${(server.address() as { port: number }).port}`; });
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
const localFetch: typeof fetch = (endpoint, init) => fetch(url + new URL(String(endpoint)).pathname, init);
it('runs the native Decisions HTTP contract and preserves real provider/primitive provenance', async () => {
  mode = 'success'; requests.length = 0;
  const result = await createOpenAIDecisions(config, { fetch: localFetch }).decide(input());
  expect(result.ok).toBe(true); if (!result.ok) return;
  expect(result.provenance).toMatchObject({ provider: 'openai', model: 'gpt-6-luna', schemaVersion: OPENAI_DECISIONS_VERSION });
  expect(result.value).toMatchObject({ companyMatch: { outcome: 'new_company' }, workstream: 'Buyer', lane: { outcome: 'no_change' } });
  expect(result.value.diagnostics.native).toMatchObject({ provider: 'openai', answers: nativeDecisionFixture().answers });
  expect(requests[0]).toMatchObject({ path: '/v1/decisions', authorization: 'Bearer synthetic-native-key', body: { model: 'gpt-6-luna' } });
  const body = requests[0]!.body as ReturnType<typeof buildOpenAIDecisionsRequest>;
  expect(body.questions).toHaveLength(7); expect(body.questions.find(q => q.name === 'supported')?.type).toBe('predicate');
  expect(body.questions.find(q => q.name === 'outbound_enquiry')?.type).toBe('predicate');
  expect(body).not.toHaveProperty('state'); expect(body).not.toHaveProperty('messages'); expect(JSON.parse(body.input).state.messages[0].text).toBe(input().messages[0]!.text);
});
it.each(['wrong_model', 'missing', 'order', 'duplicate', 'score_label', 'score_mean', 'refusal', 'boolean_choice'])('rejects unsafe/incomplete native %s without inventing probability fields', mode => {
  const raw = nativeDecisionFixture();
  if (mode === 'wrong_model') (raw as { model: string }).model = 'gpt-6.1-sol';
  if (mode === 'missing') raw.answers.pop();
  if (mode === 'order') raw.answers.reverse();
  if (mode === 'duplicate') { const a = raw.answers[0]!; if (a.type === 'choice') a.probabilities!.push(a.probabilities![0]!); }
  if (mode === 'score_label' || mode === 'score_mean') { const a = raw.answers.find(a => a.type === 'score')!; if (mode === 'score_label') a.probabilities![0]!.label = 'invented'; else a.score = 3; }
  if (mode === 'refusal') raw.answers[0] = { name: 'relevance', type: 'refusal' } as typeof raw.answers[number];
  if (mode === 'boolean_choice') (raw.answers[0] as unknown as { choice: boolean }).choice = true;
  expect(() => parseOpenAIDecisions(raw, input())).toThrow();
});
it('keeps low-confidence choices uncertain instead of manufacturing a stage proposal', () => {
  const raw = nativeDecisionFixture(); for (const a of raw.answers) if ('confidence' in a) a.confidence = 0.1;
  expect(parseOpenAIDecisions(raw, input())).toMatchObject({ relevance: 'uncertain', lane: { outcome: 'uncertain' }, workstream: null });
});
it('surfaces credit errors once and infrastructure errors as retryable, with no fallback', async () => {
  mode = 'credit'; requests.length = 0;
  const result = await createOpenAIDecisions({ ...config, maxAttempts: 3 }, { fetch: localFetch }).decide(input());
  expect(result).toMatchObject({ ok: false, code: 'entitlement', retryable: false }); expect(requests).toHaveLength(1); expect(JSON.stringify(result)).not.toContain(config.apiKey);
  mode = 'unavailable'; expect(await createOpenAIDecisions(config, { fetch: localFetch }).decide(input())).toMatchObject({ ok: false, code: 'unavailable', retryable: true });
  mode = 'hang'; expect(await createOpenAIDecisions({ ...config, timeoutMs: 25 }, { fetch: localFetch }).decide(input())).toMatchObject({ ok: false, code: 'timeout' });
});
