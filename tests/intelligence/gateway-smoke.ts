import assert from 'node:assert/strict';
import { createJevAdapter } from '../../src/intelligence/jev.js';
import { extractionFixture, inputFixture } from './fixtures.js';

const base = process.env.GATEWAY_SIM_URL ?? 'http://127.0.0.1:4951/gateway';
assert(new URL(base).hostname === '127.0.0.1', 'This smoke only targets a loopback simulation');
let calls = 0;
const result = await createJevAdapter({ provider: 'vercel', model: 'typesafe-ai/jev', endpoint: 'https://ai-gateway.vercel.sh/typesafe/v1/systemone',
  apiKey: 'synthetic-local-only', maxAttempts: 2, timeoutMs: 1000 }, { fetch: (url, init) => { calls++; return fetch(`${base}${new URL(String(url)).pathname}`, init); } }).decide({ ...inputFixture(), extraction: extractionFixture() });
assert.equal(result.ok, false);
if (!result.ok) { assert.equal(result.code, 'entitlement'); assert.equal(result.retryable, false); }
assert.equal(calls, 1);
console.log('PASS: actual Jev adapter over local Postman simulation HTTP; entitlement failure, one request, no fallback. No live model called.');
