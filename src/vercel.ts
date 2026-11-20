import { writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from './app.js';
import { createModules } from './composition.js';

/**
 * Vercel entry for APP_ROLE=web. One Fastify instance per warm function instance;
 * Telegram, workers and migrations stay on the primary process.
 * DATABASE_CA holds the Supabase root certificate that DATABASE_URL's sslrootcert names.
 */
process.env['APP_ROLE'] = 'web';
let app: Promise<Awaited<ReturnType<typeof buildApp>>> | null = null;

async function start() {
  const ca = process.env['DATABASE_CA'];
  if (ca) writeFileSync('/tmp/antseed-database-ca.crt', ca.replaceAll('\\n', '\n'), { mode: 0o600 });
  const instance = await buildApp({ modules: await createModules(), logger: true });
  await instance.ready();
  return instance;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  app ??= start().catch((error) => { app = null; throw error; });
  (await app).server.emit('request', req, res);
}
