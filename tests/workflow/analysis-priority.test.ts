import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Database } from '../../src/shared/ports.js';
import { SqlAnalysisQueue } from '../../src/workflow/analysis.js';
import { fixtureDatabase, seedJob } from './database.js';
import { jobId } from '../intelligence/fixtures.js';

let db: Database;
const now = new Date('2026-10-17T15:25:00Z');
const queue = () => new SqlAnalysisQueue(db, { now: () => now });
beforeEach(async () => {
  db = await fixtureDatabase();
  await db.query("UPDATE analysis_jobs SET created_at=$1", [new Date(now.getTime() - 7200000)]);
});
afterEach(async () => { await db?.close(); });
async function freshMessage(id: number, sender = '99', sentAt = new Date(now.getTime() - 60000), forwarded = false) {
  await db.query(`INSERT INTO messages(chat_id,id,sender_id,sent_at,text,forward_metadata)
    VALUES(-1001,$1,$2,$3,'Synthetic conversation',$4::jsonb)`, [id, sender, sentAt, JSON.stringify({ isForwarded: forwarded })]);
  const idJob = randomUUID(); await seedJob(db, idJob, '-1001', id);
  await db.query('UPDATE analysis_jobs SET created_at=$2 WHERE id=$1', [idJob, now]);
  return idJob;
}
it('processes fresh outbound enquiry ahead of the historical import backlog', async () => {
  const fresh = await freshMessage(2);
  expect((await queue().claim({ workerId: 'worker', leaseMs: 60000 }))?.id).toBe(fresh);
  expect((await db.query('SELECT status FROM analysis_jobs WHERE id=$1', [jobId])).rows[0]?.status).toBe('pending');
});
it('gives the oldest eligible job every fifth slot even after recreating the queue', async () => {
  for (let id = 2; id <= 8; id++) await freshMessage(id, '99', new Date(now.getTime() - (10-id)*1000));
  for (let i = 0; i < 4; i++) expect((await queue().claim({ workerId: 'worker', leaseMs: 60000 }))?.id).not.toBe(jobId);
  expect((await queue().claim({ workerId: 'worker', leaseMs: 60000 }))?.id).toBe(jobId);
});
it('also prioritizes the fresh recipient reply in a recent outbound conversation', async () => {
  const outgoing = await freshMessage(2); await db.query("UPDATE analysis_jobs SET status='completed' WHERE id=$1", [outgoing]);
  const incoming = await freshMessage(3, '7', now);
  expect((await queue().claim({ workerId: 'worker', leaseMs: 60000 }))?.id).toBe(incoming);
});
it('reserves live capacity instead of letting its empty poll take historical work or consume fairness', async () => {
  expect(await queue().claim({ workerId: 'live', leaseMs: 60000, recentOutboundOnly: true })).toBeNull();
  expect((await db.query('SELECT value FROM app_settings WHERE key=$1', ['workflow:analysis:dispatch'])).rows).toHaveLength(0);
  await db.query("INSERT INTO app_settings(key,value) VALUES('workflow:analysis:dispatch','4'::jsonb)");
  const fresh = await freshMessage(2);
  expect((await queue().claim({ workerId: 'live', leaseMs: 60000, recentOutboundOnly: true }))?.id).toBe(fresh);
  expect((await db.query('SELECT value FROM app_settings WHERE key=$1', ['workflow:analysis:dispatch'])).rows[0]?.value).toBe(4);
  expect((await queue().claim({ workerId: 'general', leaseMs: 60000 }))?.id).toBe(jobId);
});
it.each(['old', 'forwarded', 'incoming_only', 'delayed_retry', 'repeated_retry', 'excluded'])('does not let %s work jump ahead of the backlog', async kind => {
  const fresh = await freshMessage(2, kind === 'incoming_only' ? '7' : '99', kind === 'old' ? new Date(now.getTime()-7200000) : now, kind === 'forwarded');
  if (kind === 'delayed_retry') await db.query("UPDATE analysis_jobs SET status='retry',retry_at=$2 WHERE id=$1", [fresh, new Date(now.getTime()+60000)]);
  if (kind === 'repeated_retry') await db.query("UPDATE analysis_jobs SET status='retry',attempts=3 WHERE id=$1", [fresh]);
  if (kind === 'excluded') await db.query("UPDATE chats SET inclusion='excluded',policy_version=policy_version+1");
  const next = await queue().claim({ workerId: 'worker', leaseMs: 60000 });
  expect(next?.id ?? null).toBe(kind === 'excluded' ? null : jobId);
});
