import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { QueryResultRow } from 'pg';
import { buildApp } from '../../src/app.js';
import { createPlatformModule } from '../../src/platform/module.js';
import { loadRuntimeConfig } from '../../src/platform/config.js';
import { createWorkflowModule } from '../../src/workflow/module.js';
import type { ApplicationModule, ControlBus, Database } from '../../src/shared/ports.js';
import { connectClient } from './client.js';

function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
export async function until(test: () => boolean) { for (let i = 0; i < 600 && !test(); i++) await delay(5); if (!test()) throw new Error('Lifecycle phase deadline exceeded'); }

// Actual buildApp + createWorkflowModule + HTTP/official SDK. SQL is a controlled
// scheduling stand-in, not real PostgreSQL/session-lock/provider proof.
export async function lifecycleHarness(options: { hold?: boolean; failUnsubscribe?: boolean; onEvent?: (event: string) => void } = {}) {
  const directory = new URL('../../db/migrations/', import.meta.url);
  const ledger = await Promise.all((await readdir(directory)).filter((name) => /^\d[\w.-]*\.sql$/.test(name)).map(async (version) => ({ version, checksum: createHash('sha256').update(await readFile(new URL(version, directory))).digest('hex') })));
  const events: string[] = []; const emit = (event: string) => { events.push(event); options.onEvent?.(event); }; const entered = deferred(), release = deferred(); let closed = false, phases = 0, subscribed = false;
  const db: Database = {
    async query<R extends QueryResultRow = QueryResultRow>(sql: string) {
      if (closed) throw new Error('DB used after close'); let rows: QueryResultRow[] = [];
      if (sql.includes('pg_try_advisory_xact_lock')) rows = [{ ready: true }];
      else if (sql.includes('to_regclass')) rows = [{ name: 'schema_migrations' }];
      else if (sql === 'SELECT version,checksum FROM schema_migrations') rows = ledger;
      else if (sql.startsWith('SELECT * FROM companies WHERE')) { emit('domain_entered'); entered.resolve(); if (options.hold) await release.promise; if (closed) throw new Error('Held operation lost database'); emit('domain_complete'); }
      else if (sql.startsWith('SELECT p.id,p.ticket_id')) { phases++; emit('scheduler_phase'); }
      return { rows: rows as R[], rowCount: rows.length, command: '', fields: [], oid: 0 };
    },
    async transaction(work) { return work(db); },
    async withSessionLock() { throw new Error('Lifecycle fixture cannot establish session/advisory lock behavior'); },
    async close() { closed = true; emit('db_closed'); },
  };
  const config = await loadRuntimeConfig({ BOARD_BACKEND: 'vikunja', AI_ENV_PATH: '/antseed-no-ai-lifecycle-fixture' });
  const realPlatform = await createPlatformModule(config);
  const control: ControlBus = { subscribe() { subscribed = true; return () => { subscribed = false; emit('unsubscribed'); if (options.failUnsubscribe) throw new Error('Synthetic unsubscribe failure'); }; }, async enqueueProposal() { throw new Error('Unrelated transport'); } };
  const workflow = await createWorkflowModule({ ...realPlatform.services, db, control });
  const platform: ApplicationModule = { name: 'platform', async register() {}, async start() {}, async stop() { await db.close(); await realPlatform.stop(); }, async status() { return { state: 'ready', code: null, detail: null, checkedAt: new Date().toISOString() }; } };
  const app = await buildApp({ modules: [platform, workflow] }); const url = await app.listen({ host: '127.0.0.1', port: 0 });
  await until(() => phases > 0); const client = await connectClient(url);
  return { app, client, workflow, url, entered, release, events, phases: () => phases, closed: () => closed, subscribed: () => subscribed };
}
