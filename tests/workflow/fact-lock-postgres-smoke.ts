import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { QueryResultRow } from 'pg';
import type { Database, SqlExecutor } from '../../src/shared/ports.js';
import { PgDatabase } from '../../src/platform/database.js';
import { SqlAnalysisQueue, inputHash } from '../../src/workflow/analysis.js';
import { RecordsRepository } from '../../src/workflow/records.js';
import { processAnalysisOnce } from '../../src/workflow/processor.js';
import { inputFixture, extractionFixture, decisionFixture, provenance, jobId } from '../intelligence/fixtures.js';
import { seedJob } from './database.js';
const connection = process.env['M31_DATABASE_URL']; assert(connection && ['127.0.0.1', 'localhost'].includes(new URL(connection).hostname), 'Require isolated loopback PostgreSQL');
const schema = `fact_${randomUUID().replaceAll('-', '')}`; const uri = new URL(connection); uri.searchParams.set('options', `-c search_path=${schema}`); const db = new PgDatabase(uri.toString());
function gate() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
function observed(hook: (sql: string, tx: SqlExecutor, before: boolean) => Promise<void>): Database {
  return { query: db.query.bind(db), close: async () => {}, withSessionLock: db.withSessionLock.bind(db),
    transaction: (work) => db.transaction(async (tx) => work({ async query<R extends QueryResultRow>(sql: string, values?: unknown[]) { await hook(sql, tx, true); const result = await tx.query<R>(sql, values); await hook(sql, tx, false); return result; } })) };
}
try {
  await db.query(`CREATE SCHEMA ${schema}`); await db.query(await readFile(new URL('../../db/migrations/001_initial.sql', import.meta.url), 'utf8')); await db.query(await readFile(new URL('../../db/migrations/202610170003_contact_prospects.sql', import.meta.url), 'utf8'));
  await db.query('INSERT INTO telegram_account(self_user_id) VALUES(99)'); await db.query("INSERT INTO chats(id,kind,title,inclusion) VALUES(-1001,'supergroup','Synthetic Cedar Labs','included')"); const message = inputFixture().messages[0]!;
  await db.query('INSERT INTO messages(chat_id,id,sender_id,sent_at,text,sender_snapshot,peer_snapshot,forward_metadata) VALUES(-1001,1,7,$1,$2,$3,$4,$5)', [message.sentAt, message.text, message.sender, message.peer, message.forward]); await seedJob(db, jobId);
  const queue = new SqlAnalysisQueue(db); const first = (await queue.claim({ workerId: 'first', leaseMs: 60000 }))!; const input = await queue.loadInput(first.id); const extraction = extractionFixture(input.evidence[0]!.id);
  await queue.saveExtraction({ jobId: first.id, inputHash: inputHash(input), extraction, provenance: provenance() }, first.claimToken);
  // Null-ticket facts can be corrected before automatic company association.
  const records = new RecordsRepository(db); const fact = (await db.query('SELECT * FROM facts WHERE parent_fact_id IS NULL')).rows[0]!;
  await records.updateFact({ idempotencyKey: 'null-ticket', factId: String(fact.id), expectedVersion: Number(fact.version), actor: { party: 'antseed', contactId: null, displayName: 'AntSeed' }, state: 'open', answersFactId: null, evidenceIds: extraction.evidenceIds, dates: [] });
  await queue.complete(first.id, decisionFixture(extraction.evidenceIds[0]), provenance('vercel'), first.claimToken);
  await db.query("UPDATE tickets SET actions_source='manual'"); const secondId = randomUUID(); await seedJob(db, secondId); const second = (await queue.claim({ workerId: 'second', leaseMs: 60000 }))!; const next = await queue.loadInput(secondId);
  const current = (await db.query('SELECT * FROM facts WHERE parent_fact_id IS NULL')).rows[0]!;
  const locked = gate(), attempted = gate(), release = gate(); let pid = 0;
  const manualDb = observed(async (sql, _tx, before) => { if (!before && sql.startsWith('UPDATE facts SET actor_party')) { locked.resolve(); await release.promise; } });
  const analysisDb = observed(async (sql, tx, before) => { if (before && sql === 'SELECT id FROM chats WHERE id=$1 FOR UPDATE') { pid = Number((await tx.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid); attempted.resolve(); } });
  const manual = new RecordsRepository(manualDb).updateFact({ idempotencyKey: 'interleave', factId: String(current.id), expectedVersion: Number(current.version), actor: { party: 'antseed', contactId: null, displayName: 'AntSeed' }, state: 'completed', answersFactId: null, evidenceIds: extraction.evidenceIds, dates: [] });
  const manualSettled = manual.then(() => null, (error: unknown) => error); await locked.promise;
  const saving = new SqlAnalysisQueue(analysisDb).saveExtraction({ jobId: second.id, inputHash: inputHash(next), extraction: extractionFixture(next.evidence[0]!.id), provenance: provenance() }, second.claimToken);
  const saveSettled = saving.then(() => null, (error: unknown) => error); await attempted.promise;
  let waiting = false;
  try { for (let i = 0; i < 100; i++) { const activity = (await db.query('SELECT wait_event_type,query FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0]!; if (activity.wait_event_type === 'Lock' && String(activity.query).includes('FROM chats')) { waiting = true; break; } await delay(10); } }
  finally { release.resolve(); }
  assert(waiting, 'Analysis must wait for manual chat ownership before taking ticket/fact locks'); assert.equal(await manualSettled, null); assert.equal(await saveSettled, null);
  assert.deepEqual((await db.query('SELECT source,state FROM facts WHERE id=$1', [current.id])).rows[0], { source: 'manual', state: 'completed' });
  await queue.fail(second.id, { ok: false, code: 'unavailable', retryable: false, retryAt: null, detail: '' }, second.claimToken);
  // Real transactions/rollback with deterministic SQLSTATE faults at checkpoint and completion.
  for (const [code, phase] of [['40P01', 'checkpoint'], ['40001', 'complete']] as const) {
    const id = randomUUID(); await seedJob(db, id); let injected = false;
    const faulted = observed(async (sql, _tx, before) => { if (before && !injected && (phase === 'checkpoint' ? sql.startsWith('SELECT source FROM facts') : sql.startsWith('UPDATE analysis_jobs SET decision='))) { injected = true; throw Object.assign(new Error('Synthetic transaction abort'), { code }); } });
    await processAnalysisOnce({ queue: new SqlAnalysisQueue(faulted), extraction: { async extract(i) { return { ok: true, value: extractionFixture(i.evidence[0]!.id), provenance: provenance() }; }, async status() { throw new Error('unused'); } }, jev: { async decide(i) { const decision = decisionFixture(i.evidence[0]!.id); decision.companyMatch = { outcome: 'matched', companyId: i.chat.companyId!, confidence: 1 }; return { ok: true, value: decision, provenance: provenance('vercel') }; }, async status() { throw new Error('unused'); } } }, { workerId: 'processor', leaseMs: 60000 });
    assert(injected); const result = (await db.query('SELECT status,last_error,retry_at,extraction FROM analysis_jobs WHERE id=$1', [id])).rows[0]!;
    assert.equal(result.status, 'retry'); assert.equal(result.last_error, 'provider_unavailable'); assert(result.retry_at); if (phase === 'complete') assert(result.extraction, 'Current successful extraction survives completion transaction failure');
  }
  process.stdout.write('Actual PostgreSQL manual/analysis lock interleaving, null-ticket precedence, SQL40P01/40001 retry + checkpoint retention PASS\n');
} finally { await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.close(); }
