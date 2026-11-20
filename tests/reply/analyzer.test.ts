import { describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../../src/shared/ports.js';
import { createOpenAIReplyAnalyzer } from '../../src/reply/analyzer.js';

const config: RuntimeConfig['extraction'] = { provider: 'openai', model: 'test-model', apiKey: 'synthetic-key', timeoutMs: 1_000, maxAttempts: 1, maxOutputTokens: 1_000 };
const input = {
  chatTitle: 'Founders Group', ownerNames: ['Ravi', 'Ravikant'], freshMessageIds: [20], now: '2026-11-20T10:30:00.000Z', timezone: 'Asia/Kolkata',
  messages: [{ id: 20, sentAt: '2026-11-20T10:20:00.000Z', from: 'other' as const, senderName: 'Member', text: 'Can you confirm the delivery date?' }],
};
const answer = (value: unknown) => new Response(JSON.stringify({ model: 'test-model', status: 'completed', error: null, incomplete_details: null, usage: { input_tokens: 10, output_tokens: 20 },
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }), { status: 200, headers: { 'content-type': 'application/json' } });

describe('reply analyzer', () => {
  it('returns a relevant draft and provenance', async () => {
    const analyzer = createOpenAIReplyAnalyzer(config, { fetch: async () => answer({ relevant: true, addressedTo: 'Ravi', urgency: 'today', reason: 'Ravi must confirm the date', suggestedText: '  Yes, Friday works.  ', confidence: 0.9 }) });
    const result = await analyzer.analyze(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.suggestedText).toBe('Yes, Friday works.');
    expect(result.value.addressedTo).toBe('Ravi');
    expect(result.provenance.schemaVersion).toBe('reply-suggestion.v1');
  });
  it('rejects a relevant answer with no draft', async () => {
    const analyzer = createOpenAIReplyAnalyzer(config, { fetch: async () => answer({ relevant: true, addressedTo: 'Ravi', urgency: 'today', reason: 'Needs a reply', suggestedText: '   ', confidence: 0.4 }) });
    const result = await analyzer.analyze(input);
    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'invalid_response' }));
  });
  it('normalizes an irrelevant answer to an empty draft', async () => {
    const analyzer = createOpenAIReplyAnalyzer(config, { fetch: async () => answer({ relevant: false, addressedTo: 'Unspecified', urgency: 'later', reason: 'Announcement only', suggestedText: 'ignored', confidence: 0.1 }) });
    const result = await analyzer.analyze(input);
    expect(result.ok && result.value).toEqual(expect.objectContaining({ relevant: false, suggestedText: '' }));
  });
  it('reports an unconfigured provider without a network call', async () => {
    let calls = 0;
    const analyzer = createOpenAIReplyAnalyzer({ ...config, apiKey: null }, { fetch: async () => { calls++; return answer({}); } });
    const result = await analyzer.analyze(input);
    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'unconfigured' }));
    expect(calls).toBe(0);
  });
  it('rejects the request when the input has no fresh messages', async () => {
    const analyzer = createOpenAIReplyAnalyzer(config, { fetch: async () => answer({}) });
    expect(await analyzer.analyze({ ...input, freshMessageIds: [] })).toEqual(expect.objectContaining({ ok: false, code: 'invalid_response' }));
  });
});
