import { afterEach, expect, it, vi } from 'vitest';
import { DomainError } from '../../src/shared/api.js';
import { SqlAnalysisQueue } from '../../src/workflow/analysis.js';
import { processAnalysisOnce } from '../../src/workflow/processor.js';
import { extractionFixture, provenance } from '../intelligence/fixtures.js';
import { fixtureDatabase } from './database.js';
const cleanups: (() => Promise<void>)[] = []; afterEach(async () => { await Promise.all(cleanups.splice(0).map((close) => close())); });
it.each(['40P01', '40001', '08006'])('requeues SQL %s with the original captured claim instead of blaming a model', async (code) => {
  const db = await fixtureDatabase(); cleanups.push(() => db.close()); let instant = new Date('2026-10-17T00:00:00Z'); const queue = new SqlAnalysisQueue(db, { now: () => instant });
  vi.spyOn(queue, 'saveExtraction').mockRejectedValueOnce(Object.assign(new Error('Synthetic transaction interruption'), { code }));
  await processAnalysisOnce({ queue, extraction: { async extract(input) { return { ok: true, value: extractionFixture(input.evidence[0]!.id), provenance: provenance() }; }, async status() { throw new Error('unused'); } }, jev: { async decide() { throw new Error('No Jev call after interrupted checkpoint'); }, async status() { throw new Error('unused'); } } }, { workerId: 'same', leaseMs: 60000 });
  const row = (await db.query('SELECT * FROM analysis_jobs')).rows[0]!; expect(row).toMatchObject({ status: 'retry', last_error: 'provider_unavailable', worker_id: null }); expect(row.retry_at).not.toBeNull();
  expect(await queue.claim({ workerId: 'same', leaseMs: 60000 })).toBeNull(); instant = new Date(instant.getTime() + 60001); expect(await queue.claim({ workerId: 'same', leaseMs: 60000 })).not.toBeNull();
});
it('keeps an explicit validation error distinct from infrastructure interruption', async () => {
  const db = await fixtureDatabase(); cleanups.push(() => db.close()); const queue = new SqlAnalysisQueue(db, { now: () => new Date('2026-10-17T00:00:00Z') }); vi.spyOn(queue, 'saveExtraction').mockRejectedValueOnce(new DomainError('validation', 'Synthetic validation error'));
  await processAnalysisOnce({ queue, extraction: { async extract(input) { return { ok: true, value: extractionFixture(input.evidence[0]!.id), provenance: provenance() }; }, async status() { throw new Error('unused'); } }, jev: { async decide() { throw new Error('unused'); }, async status() { throw new Error('unused'); } } }, { workerId: 'worker', leaseMs: 60000 });
  expect((await db.query('SELECT status,last_error FROM analysis_jobs')).rows[0]).toMatchObject({ status: 'provider_unavailable', last_error: 'provider_invalid_response' });
});
