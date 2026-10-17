import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PgDatabase } from '../../src/platform/database.js';
import { SqlAnalysisQueue, inputHash } from '../../src/workflow/analysis.js';
import { RecordsRepository } from '../../src/workflow/records.js';
import { decisionFixture, extractionFixture, inputFixture, provenance } from '../intelligence/fixtures.js';
import { seedJob } from './database.js';

const connectionString = process.env.M31_DATABASE_URL;
assert(connectionString && ['127.0.0.1', 'localhost'].includes(new URL(connectionString).hostname), 'Requires an explicit isolated loopback test PostgreSQL URL');
const schema = `m31_${randomUUID().replaceAll('-', '')}`;
const isolatedUrl = new URL(connectionString);
isolatedUrl.searchParams.set('options', `-c search_path=${schema}`);
const db = new PgDatabase(isolatedUrl.toString());
const pool = db.pool;
try {
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(await readFile(new URL('../../db/migrations/001_initial.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../../db/migrations/202610170003_contact_prospects.sql', import.meta.url), 'utf8'));
  await pool.query('INSERT INTO telegram_account(self_user_id) VALUES(99)');
  const message = inputFixture().messages[0]!;
  for (const id of ['-1001', '-1002']) {
    await pool.query("INSERT INTO chats(id,kind,title,inclusion) VALUES($1,'supergroup','Cedar Labs','included')", [id]);
    await pool.query('INSERT INTO messages(chat_id,id,sender_id,sent_at,text,sender_snapshot,peer_snapshot,forward_metadata) VALUES($1,1,7,$2,$3,$4,$5,$6)', [id, message.sentAt, message.text, message.sender, message.peer, message.forward]);
    await seedJob(db, randomUUID(), id);
  }
  let instant = new Date(); const clock = { now: () => instant };
  const first = new SqlAnalysisQueue(db, clock); const second = new SqlAnalysisQueue(db, clock);
  const claims = await Promise.all([first.claim({ workerId: 'same-worker', leaseMs: 60000 }), second.claim({ workerId: 'same-worker', leaseMs: 60000 })]);
  assert(claims[0] && claims[1]); assert.notEqual(claims[0].id, claims[1].id);
  for (const [i, queue] of [first, second].entries()) {
    const job = claims[i]!; const input = await queue.loadInput(job.id); const extraction = extractionFixture(input.evidence[0]!.id);
    await queue.saveExtraction({ jobId: job.id, inputHash: inputHash(input), extraction, provenance: provenance() }, job.claimToken);
  }
  // Both checkpoints exist before either complete: real connection locking protects directory dedupe.
  const completed = await Promise.allSettled([first, second].map(async (queue, i) => {
    const checkpoint = await queue.getExtraction(claims[i]!.id); assert(checkpoint);
    await queue.complete(claims[i]!.id, decisionFixture(checkpoint.extraction.evidenceIds[0]), provenance('vercel'), claims[i]!.claimToken);
  }));
  // A directory context change can conservatively invalidate the other hash; replay it with current input.
  for (let i = 0; i < completed.length; i++) if (completed[i]!.status === 'rejected') {
    const queue = [first, second][i]!; const claim = claims[i]!; const input = await queue.loadInput(claim.id); const extraction = extractionFixture(input.evidence[0]!.id);
    await queue.saveExtraction({ jobId: claim.id, inputHash: inputHash(input), extraction, provenance: provenance() }, claim.claimToken);
    await queue.complete(claim.id, decisionFixture(extraction.evidenceIds[0]), provenance('vercel'), claim.claimToken);
  }
  assert.equal((await pool.query('SELECT * FROM companies')).rows.length, 1);
  assert.equal((await pool.query('SELECT * FROM contacts')).rows.length, 1);
  const records = new RecordsRepository(db); assert.equal((await records.listTickets({})).items.length, 2);
  const writes = { idempotencyKey: 'concurrent-command', canonicalName: 'Maple', aliases: [], domains: [], buyerIds: [], providerIds: [], workstream: null, summary: '', evidenceIds: [] };
  const commands = await Promise.all([records.createCompany(writes), records.createCompany(writes)]); assert.equal(commands[0].id, commands[1].id);
  // Same external worker ID, different tokens after a real persisted lease expires.
  await seedJob(db, randomUUID()); const old = (await first.claim({ workerId: 'same-worker', leaseMs: 10 }))!;
  const input = await first.loadInput(old.id); const checkpoint = { jobId: old.id, inputHash: inputHash(input), extraction: extractionFixture(input.evidence[0]!.id), provenance: provenance() };
  instant = new Date(instant.getTime() + 11); const fresh = (await second.claim({ workerId: 'same-worker', leaseMs: 60000 }))!;
  assert.equal(fresh.id, old.id); assert.notEqual(fresh.claimToken, old.claimToken);
  await second.saveExtraction(checkpoint, fresh.claimToken);
  await assert.rejects(first.saveExtraction(checkpoint, old.claimToken));
  await assert.rejects(first.complete(old.id, decisionFixture(input.evidence[0]!.id), provenance('vercel'), old.claimToken));
  await assert.rejects(first.fail(old.id, { ok: false, code: 'entitlement', retryable: false, retryAt: null, detail: '' }, old.claimToken));
  assert.equal((await pool.query('SELECT worker_id FROM analysis_jobs WHERE id=$1', [old.id])).rows[0].worker_id, fresh.claimToken);
  console.log('PASS: isolated real PostgreSQL multi-connection claim, directory/idempotency concurrency, checkpoint and stale-callback fencing. No live models, Telegram or Vikunja called.');
} finally { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.close(); }
