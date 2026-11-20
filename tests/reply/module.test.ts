import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import type { QueryResult, QueryResultRow } from 'pg';
import { afterEach, expect, it } from 'vitest';
import type { Database, PlatformServices, TelegramPort } from '../../src/shared/ports.js';
import { DomainError, ERROR_HTTP_STATUS } from '../../src/shared/api.js';
import { loadRuntimeConfig } from '../../src/platform/config.js';
import { createReplyModule } from '../../src/reply/module.js';

const migration = (name: string) => new URL(`../../db/migrations/${name}`, import.meta.url);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((close) => close())); });

async function fixture() {
  const engine = new PGlite();
  for (const name of ['001_initial.sql', '202610170001_telegram_operations.sql', '202610230002_automatic_conversation_scope.sql', '202611200005_reply_agent.sql'])
    await engine.exec(await readFile(migration(name), 'utf8'));
  const toResult = <R extends QueryResultRow>(rows: R[], affectedRows?: number): QueryResult<R> => ({ rows, rowCount: rows.length || affectedRows || 0, fields: [], command: '', oid: 0 });
  const db = {
    async query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) { const result = await engine.query<R>(text, values); return toResult(result.rows, result.affectedRows); },
    transaction: async <T>(work: (tx: { query: typeof db.query }) => Promise<T>) => engine.transaction((tx) => work({ async query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) { const result = await tx.query<R>(text, values); return toResult(result.rows, result.affectedRows); } })) as Promise<T>,
    close: () => engine.close(),
  } as unknown as Database;
  return { engine, db };
}

/** The module only reads status and history here; no Telegram session is opened. */
const telegram = {
  authorizedSelf: async () => null,
  status: async () => ({ state: 'connecting', code: null, detail: null, checkedAt: '2026-11-20T10:00:00.000Z' }),
  getHistory: async () => ({ messages: [], next: null, complete: true }),
} as unknown as TelegramPort;

async function build(db: Database, values: Record<string, string> = {}) {
  const config = await loadRuntimeConfig({ AI_ENV_PATH: '/tmp/antseed-nonexistent-config-for-reply-module-test', ...values });
  const platform = { config, clock: { now: () => new Date('2026-11-20T10:00:00.000Z') }, db, telegram } as unknown as PlatformServices;
  const module = await createReplyModule(platform);
  const app = Fastify();
  // The platform module owns the real handler; mirror its status mapping here.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) return reply.status(ERROR_HTTP_STATUS[error.code]).send({ error: { code: error.code, message: error.message, retryable: error.retryable } });
    return reply.status(500).send({ error: { code: 'internal', message: 'Internal server error', retryable: false } });
  });
  cleanups.push(() => app.close());
  await module.register(app);
  return { module, app, config };
}

it('serves status and an empty suggestion list without a Telegram session or provider key', async () => {
  const { engine, db } = await fixture(); cleanups.push(() => engine.close());
  const { module, app } = await build(db);
  const status = (await app.inject({ method: 'GET', url: '/api/reply/status' })).json();
  expect(status).toMatchObject({ state: 'connecting', configuration: { enabled: true, intervalMs: 3_600_000, maxChats: 25, contextMessages: 15, windowMinutes: 60, digestChatId: 'self' } });
  const list = await app.inject({ method: 'GET', url: '/api/reply/suggestions' });
  expect(list.statusCode).toBe(200);
  expect(list.json()).toEqual({ items: [], nextBefore: null });
  await module.stop();
});

it('reports a missing Telegram login and stores no suggestion', async () => {
  const { engine, db } = await fixture(); cleanups.push(() => engine.close());
  const { module, app } = await build(db, { OPENAI_API_KEY: 'synthetic-not-a-real-key' });
  const scan = await app.inject({ method: 'POST', url: '/api/reply/scan' });
  expect(scan.statusCode).toBe(200);
  expect(scan.json()).toEqual({ chats: 0, skipped: 0, failed: 0, suggestions: 0, delivered: 0 });
  expect((await app.inject({ method: 'GET', url: '/api/reply/status' })).json()).toMatchObject({ state: 'degraded', code: 'login_required' });
  expect((await db.query('SELECT count(*)::int AS n FROM reply_suggestions')).rows[0]).toEqual({ n: 0 });
  await module.stop();
});

it('rejects a manual scan on the web role but still lists stored suggestions', async () => {
  const { engine, db } = await fixture(); cleanups.push(() => engine.close());
  const { module, app } = await build(db, { APP_ROLE: 'web' });
  expect((await app.inject({ method: 'POST', url: '/api/reply/scan' })).statusCode).toBe(403);
  expect((await app.inject({ method: 'GET', url: '/api/reply/suggestions' })).statusCode).toBe(200);
  await module.start();
  expect(await module.status()).toMatchObject({ state: 'ready', detail: expect.stringContaining('primary process') as unknown as string });
  await module.stop();
});

it('stop is terminal and a later start does not arm the worker', async () => {
  const { engine, db } = await fixture(); cleanups.push(() => engine.close());
  const { module } = await build(db, { REPLY_AGENT_ENABLED: 'false' });
  await module.stop();
  await module.start();
  expect(await module.status()).toMatchObject({ state: 'connecting', detail: 'Reply agent has not started' });
  await module.start();
  await module.stop();
});

it('reports the disabled worker when it starts normally', async () => {
  const { engine, db } = await fixture(); cleanups.push(() => engine.close());
  const { module } = await build(db, { REPLY_AGENT_ENABLED: 'false' });
  await module.start();
  expect(await module.status()).toMatchObject({ state: 'ready', detail: expect.stringContaining('disabled') as unknown as string });
  await module.stop();
});

it('refuses configuration that cannot name the owner or a valid digest target', async () => {
  await expect(loadRuntimeConfig({ AI_ENV_PATH: '/tmp/antseed-nonexistent-config-for-reply-module-test', REPLY_AGENT_OWNER_NAMES: ' , ' }))
    .rejects.toThrow('REPLY_AGENT_OWNER_NAMES');
  await expect(loadRuntimeConfig({ AI_ENV_PATH: '/tmp/antseed-nonexistent-config-for-reply-module-test', REPLY_AGENT_DIGEST_CHAT: 'saved' }))
    .rejects.toThrow('REPLY_AGENT_DIGEST_CHAT');
  await expect(loadRuntimeConfig({ AI_ENV_PATH: '/tmp/antseed-nonexistent-config-for-reply-module-test', REPLY_AGENT_INTERVAL_MS: '0' }))
    .rejects.toThrow('REPLY_AGENT_INTERVAL_MS');
});
