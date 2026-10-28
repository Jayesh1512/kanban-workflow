import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerFathomWebhook, verifyFathomWebhook } from '../../src/meetings/webhook.js';
import { ingestionDatabase } from './ingestion-test-helper.js';
import { PgDatabase } from '../../src/platform/database.js';

const now = new Date('2026-10-26T10:00:00Z');
const bytes = Buffer.from('synthetic-webhook-signing-secret'); const secret = `whsec_${bytes.toString('base64')}`;
function headers(raw: string, id = 'event-1', timestamp = String(now.getTime() / 1000)) {
  return { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${createHmac('sha256', bytes).update(`${id}.${timestamp}.${raw}`).digest('base64')}` };
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
describe('Fathom raw webhook verification', () => {
  it('uses exact bytes, timestamp tolerance, versioned valid-length signatures and strict secret decoding', () => {
    const raw = '{ "unknown": "shape" }'; const valid = headers(raw);
    expect(verifyFathomWebhook(secret, valid, Buffer.from(raw), now)).toBe(true);
    expect(verifyFathomWebhook(secret, valid, Buffer.from('{"unknown":"shape"}'), now)).toBe(false);
    expect(verifyFathomWebhook(secret, headers(raw, 'event', String(now.getTime() / 1000 - 301)), Buffer.from(raw), now)).toBe(false);
    expect(verifyFathomWebhook(secret, headers(raw, 'event', String(now.getTime() / 1000 + 301)), Buffer.from(raw), now)).toBe(false);
    expect(verifyFathomWebhook(secret, { ...valid, 'webhook-signature': `v1,a v2,${'A'.repeat(44)} ${valid['webhook-signature']}` }, Buffer.from(raw), now)).toBe(true);
    for (const value of ['', 'v1,a', 'v1,@@@@', 'v2,AAAA', 'garbage']) expect(verifyFathomWebhook(secret, { ...valid, 'webhook-signature': value }, Buffer.from(raw), now)).toBe(false);
    expect(verifyFathomWebhook('whsec_@@@', valid, Buffer.from(raw), now)).toBe(false);
    expect(verifyFathomWebhook(null, valid, Buffer.from(raw), now)).toBe(false);
    expect(verifyFathomWebhook(secret, { ...valid, 'webhook-id': ['one', 'two'] }, Buffer.from(raw), now)).toBe(false);
    expect(verifyFathomWebhook(secret, { ...valid, 'webhook-timestamp': `${valid['webhook-timestamp']}junk` }, Buffer.from(raw), now)).toBe(false);
  });
  it('durably stores unknown raw payloads, deduplicates delivery and rejects changed bodies with the same ID', async () => {
    const db = await ingestionDatabase(); cleanup.push(() => db.close());
    const app = Fastify(); cleanup.unshift(() => app.close());
    app.post('/normal', async request => ({ parsed: request.body }));
    await registerFathomWebhook(app, { db, secret, clock: { now: () => now } });
    const raw = '{ "completely_unknown": [1, 2], "transcript": "untrusted" }';
    const first = await app.inject({ method: 'POST', url: '/api/integrations/fathom/webhook', headers: headers(raw), payload: raw });
    expect(first.statusCode).toBe(202);
    expect((await app.inject({ method: 'POST', url: '/api/integrations/fathom/webhook', headers: headers(raw), payload: raw })).statusCode).toBe(202);
    const changed = '{}'; expect((await app.inject({ method: 'POST', url: '/api/integrations/fathom/webhook', headers: headers(changed), payload: changed })).statusCode).toBe(409);
    const rows = (await db.query('SELECT * FROM meeting_webhook_inbox')).rows;
    expect(rows).toHaveLength(1); expect(Buffer.from(rows[0]!.raw_body).toString()).toBe(raw);
    expect(rows[0]!.payload).toEqual({ completely_unknown: [1, 2], transcript: 'untrusted' }); expect(rows[0]!.processed_at).toBeNull();
    expect((await db.query('SELECT count(*)::int AS count FROM test_ingestion')).rows[0]!.count).toBe(0);
    expect((await app.inject({ method: 'POST', url: '/normal', payload: { normal: true } })).json()).toEqual({ parsed: { normal: true } });
    const malformed = 'authenticated non-JSON';
    expect((await app.inject({ method: 'POST', url: '/api/integrations/fathom/webhook', headers: headers(malformed, 'non-json'), payload: malformed })).statusCode).toBe(202);
  });
  it('fails closed, rejects oversize requests and returns retryable failure before claiming acceptance', async () => {
    const db = await ingestionDatabase(); cleanup.push(() => db.close());
    const app = Fastify(); cleanup.unshift(() => app.close());
    await registerFathomWebhook(app, { db, secret, clock: { now: () => now }, ready: async () => { throw new Error('migration gate closed'); } });
    const raw = '{}';
    expect((await app.inject({ method: 'POST', url: '/api/integrations/fathom/webhook', payload: raw })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/integrations/fathom/webhook', headers: headers(raw), payload: raw })).statusCode).toBe(503);
    const large = 'x'.repeat(20 * 1024 * 1024 + 1);
    expect((await app.inject({ method: 'POST', url: '/api/integrations/fathom/webhook', headers: headers(large), payload: large })).statusCode).toBe(413);
    const noSecret = Fastify(); cleanup.unshift(() => noSecret.close()); await registerFathomWebhook(noSecret, { db, secret: null });
    expect((await noSecret.inject({ method: 'POST', url: '/api/integrations/fathom/webhook', headers: headers(raw), payload: raw })).statusCode).toBe(503);
    expect((await db.query('SELECT count(*)::int AS count FROM meeting_webhook_inbox')).rows[0]!.count).toBe(0);
  });
});

const postgresUrl = process.env['MEETINGS_TEST_DATABASE_URL'];
describe.skipIf(!postgresUrl)('real PostgreSQL webhook inbox concurrency', () => {
  it('acknowledges competing identical deliveries only after one durable row and rejects a concurrent changed body', async () => {
    const schema = `meeting_webhook_${randomUUID().replaceAll('-', '')}`;
    const admin = new PgDatabase(postgresUrl!); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(postgresUrl!); scoped.searchParams.set('options', `-c search_path=${schema},public`);
    const db = new PgDatabase(scoped.toString()); const other = new PgDatabase(scoped.toString());
    const app = Fastify(); const app2 = Fastify();
    try {
      await db.query(await readFile(new URL('../../db/migrations/202610260004_meeting_ingestion.sql', import.meta.url), 'utf8'));
      await registerFathomWebhook(app, { db, secret, clock: { now: () => now } });
      await registerFathomWebhook(app2, { db: other, secret, clock: { now: () => now } });
      const payload = '{ "unknown": [1, 2, 3] }';
      const deliver = (target: typeof app, raw = payload) => target.inject({ method: 'POST', url: '/api/integrations/fathom/webhook', headers: headers(raw), payload: raw });
      const results = await Promise.all([deliver(app), deliver(app2), deliver(app), deliver(app2)]);
      expect(results.map(result => result.statusCode)).toEqual([202, 202, 202, 202]);
      expect((await db.query('SELECT count(*)::int AS count FROM meeting_webhook_inbox')).rows[0]!.count).toBe(1);
      const changed = await Promise.all([deliver(app), deliver(app2, '{"changed":true}')]);
      expect(changed.map(result => result.statusCode)).toEqual([202, 409]);
    } finally { await app.close(); await app2.close(); await db.close(); await other.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); }
  });
});
