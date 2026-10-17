import assert from 'node:assert/strict';
import { createOpenAIDecisions } from '../../../src/intelligence/openai-decisions.js';
import { extractionFixture, inputFixture } from '../fixtures.js';
const address = process.env['DECISIONS_SIMULATION_URL'];
assert(address && new URL(address).hostname === '127.0.0.1', 'Set DECISIONS_SIMULATION_URL to the loopback Postman simulation');
const adapter = createOpenAIDecisions({ provider: 'openai', endpoint: 'https://api.openai.com/v1/decisions', model: 'gpt-6-luna', apiKey: 'synthetic-only-key', timeoutMs: 3000, maxAttempts: 1 }, { fetch: (url, init) => fetch(`${address}/openai${new URL(String(url)).pathname}`, init) });
const result = await adapter.decide({ ...inputFixture(), extraction: extractionFixture() });
assert(result.ok); assert.equal(result.provenance.provider, 'openai'); assert.equal(result.value.model, 'gpt-6-luna'); assert.equal(result.value.lane.outcome, 'no_change');
console.log(JSON.stringify({ pass: true, synthetic: true, provider: result.provenance.provider, model: result.value.model, outcome: result.value.lane.outcome }));
