import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PgDatabase } from '../../src/platform/database.js';
import { SqlAnalysisQueue, inputHash } from '../../src/workflow/analysis.js';
import { RecordsRepository } from '../../src/workflow/records.js';
import { inputFixture, extractionFixture, decisionFixture, provenance, jobId } from '../intelligence/fixtures.js';
import { seedJob } from './database.js';

const connectionString = process.env['M31_DATABASE_URL'];
assert(connectionString && ['127.0.0.1', 'localhost'].includes(new URL(connectionString).hostname), 'Requires an explicit isolated loopback PostgreSQL URL');
if (process.env['DATE_SMOKE_CHILD'] !== '1') {
  for (const timezone of ['Asia/Kolkata', 'UTC', 'America/Los_Angeles']) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url)], { env: { ...process.env, TZ: timezone, DATE_SMOKE_CHILD: '1' }, encoding: 'utf8' });
    // Child assertions contain synthetic facts/dates only. No URL or config values are printed.
    assert.equal(result.status, 0, `Date regression failed in ${timezone}: ${result.stderr}`);
    process.stdout.write(result.stdout);
  }
} else {
  const schema = `date_${randomUUID().replaceAll('-', '')}`; const url = new URL(connectionString); url.searchParams.set('options', `-c search_path=${schema}`);
  const db = new PgDatabase(url.toString());
  try {
    await db.query(`CREATE SCHEMA ${schema}`); await db.query(await readFile(new URL('../../db/migrations/001_initial.sql', import.meta.url), 'utf8'));
    await db.query('INSERT INTO telegram_account(self_user_id) VALUES(99)'); await db.query("INSERT INTO chats(id,kind,title,inclusion) VALUES(-1001,'supergroup','Synthetic Cedar Labs','included')");
    const message = inputFixture().messages[0]!;
    await db.query('INSERT INTO messages(chat_id,id,sender_id,sent_at,text,sender_snapshot,peer_snapshot,forward_metadata) VALUES(-1001,1,7,$1,$2,$3,$4,$5)', [message.sentAt, message.text, message.sender, message.peer, message.forward]); await seedJob(db, jobId);
    const clock = { now: () => new Date('2026-10-17T00:00:00Z') }; const queue = new SqlAnalysisQueue(db, clock); const job = (await queue.claim({ workerId: 'date-smoke', leaseMs: 60000 }))!;
    const input = await queue.loadInput(job.id); const extraction = extractionFixture(input.evidence[0]!.id);
    await queue.saveExtraction({ jobId: job.id, inputHash: inputHash(input), extraction, provenance: provenance() }, job.claimToken);
    await queue.complete(job.id, decisionFixture(input.evidence[0]!.id), provenance('vercel'), job.claimToken);
    const records = new RecordsRepository(db, clock); const ticket = (await records.listTickets({})).items[0]!;
    const facts = (await records.listFacts({ ticketId: ticket.id, limit: 20 })).items; const date = facts[0]!.dates[0]!;
    assert.equal(date.localDate, '2026-10-18'); assert.equal(date.resolvedAt, null); assert.equal(date.precision, 'date');
    assert.equal((await records.getContext({ ticketId: ticket.id, limit: 20 })).facts[0]!.dates[0]!.localDate, '2026-10-18');
    const today = await records.priorities({ date: '2026-10-18', timezone: 'Asia/Kolkata', limit: 20 });
    assert(today[0]!.reasons.includes('upcoming')); assert(!today[0]!.reasons.includes('overdue'));
    assert((await records.priorities({ date: '2026-10-19', timezone: 'Asia/Kolkata', limit: 20 }))[0]!.reasons.includes('overdue'));
    await records.updateFact({ idempotencyKey: 'instant', factId: facts[0]!.id, expectedVersion: facts[0]!.version, actor: facts[0]!.actor, state: 'open', answersFactId: null, evidenceIds: facts[0]!.evidenceIds,
      dates: [{ ...date, localDate: null, precision: 'instant', resolvedAt: '2026-10-18T06:30:00.000Z' }] });
    const instant = (await records.listFacts({ ticketId: ticket.id, limit: 20 })).items[0]!.dates[0]!;
    assert.equal(instant.localDate, null); assert.equal(instant.resolvedAt, '2026-10-18T06:30:00.000Z');
    process.stdout.write(`Date-only facts/context/priorities + instant precision PASS: TZ=${process.env['TZ']}\n`);
  } finally { await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.close(); }
}
