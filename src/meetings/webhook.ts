import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Clock, Database } from '../shared/ports.js';

type Headers = Record<string, string | string[] | undefined>;
function one(headers: Headers, key: string): string | null { const value = headers[key]; return typeof value === 'string' ? value : null; }
function base64(value: string): Buffer | null {
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length && bytes.toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '') ? bytes : null;
}
/** Verify bytes before JSON parsing. Every candidate must have the correct digest length. */
export function verifyFathomWebhook(secret: string | null, headers: Headers, raw: Buffer, now = new Date(), toleranceSeconds = 300): boolean {
  if (!secret?.startsWith('whsec_')) return false;
  const key = base64(secret.slice(6)); const id = one(headers, 'webhook-id');
  const timestamp = one(headers, 'webhook-timestamp'); const signatures = one(headers, 'webhook-signature');
  if (!key || !id || id.length > 512 || !timestamp || !/^\d{1,12}$/.test(timestamp) || !signatures) return false;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(Math.floor(now.getTime() / 1000) - seconds) > toleranceSeconds) return false;
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(raw).digest();
  let verified = false;
  for (const candidate of signatures.split(/\s+/)) {
    const match = /^v1,([A-Za-z0-9+/]+={0,2})$/.exec(candidate); const supplied = match ? base64(match[1]!) : null;
    if (supplied?.length === expected.length) verified = timingSafeEqual(expected, supplied) || verified;
  }
  return verified;
}
export interface FathomWebhookOptions { db: Database; secret: string | null; clock?: Clock; ready?: () => Promise<void> }
export async function registerFathomWebhook(app: FastifyInstance, options: FathomWebhookOptions): Promise<void> {
  await app.register(async scope => {
    scope.setErrorHandler((error, _request, reply) => {
      const tooLarge = error instanceof Error && 'code' in error && error.code === 'FST_ERR_CTP_BODY_TOO_LARGE';
      return reply.code(tooLarge ? 413 : 500).send({ error: tooLarge ? 'Webhook exceeds the 20 MiB request limit; use API reconciliation' : 'Webhook request could not be read' });
    });
    // Encapsulation keeps every other route's normal JSON parser and body limits intact.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 20 * 1024 * 1024 }, (_request, body, done) => done(null, body));
    scope.post('/api/integrations/fathom/webhook', { bodyLimit: 20 * 1024 * 1024 }, async (request, reply) => {
      if (!options.secret) return reply.code(503).send({ error: 'Webhook signing secret is not configured' });
      const raw = request.body;
      if (!Buffer.isBuffer(raw) || !verifyFathomWebhook(options.secret, request.headers, raw, options.clock?.now() ?? new Date()))
        return reply.code(401).send({ error: 'Invalid webhook signature' });
      const digest = createHash('sha256').update(raw).digest('hex');
      let payload: unknown = null;
      try { payload = JSON.parse(raw.toString('utf8')); } catch { /* Authenticated unknown bytes remain in the inbox for diagnosis. */ }
      try {
        await options.ready?.();
        const accepted = await options.db.transaction(async tx => {
          await tx.query(`INSERT INTO meeting_webhook_inbox(id,webhook_id,webhook_timestamp,body_sha256,raw_body,payload,received_at)
            VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT(connection_key,webhook_id) DO NOTHING`,
          [randomUUID(), request.headers['webhook-id'], Number(request.headers['webhook-timestamp']), digest, raw, JSON.stringify(payload), options.clock?.now() ?? new Date()]);
          const existing = (await tx.query<{ body_sha256: string }>('SELECT body_sha256 FROM meeting_webhook_inbox WHERE connection_key=$1 AND webhook_id=$2', ['fathom-default', request.headers['webhook-id']])).rows[0];
          return existing?.body_sha256 === digest;
        });
        if (!accepted) return reply.code(409).send({ error: 'Webhook ID was already received with different bytes' });
        return reply.code(202).send({ accepted: true });
      } catch { return reply.code(503).send({ error: 'Webhook inbox is temporarily unavailable' }); }
    });
  });
}
