import assert from 'node:assert/strict';
import { FathomClient } from '../../src/meetings/fathom.js';

const baseUrl = process.env['FATHOM_SIM_BASE_URL'] ?? 'http://127.0.0.1:19482/fathom/external/v1/';
const client = new FathomClient({ apiKey: 'synthetic-fathom-key', baseUrl, timeoutMs: 3000 });
const page = await client.listMeetings({ createdAfter: '2026-10-01T00:00:00Z', createdBefore: '2026-10-27T00:00:00Z' });
assert.equal(page.items[0]?.recording_id, 90001);
assert.equal(page.items[0]?.transcript?.length, 4);
assert.equal(page.items[0]?.action_items?.length, 2);
assert.equal(page.next_cursor, null);
console.log('Fathom client passed the local Postman HTTP contract simulation.');
