import type { AnalysisQueue, ExtractionPort, JevPort } from '../shared/ports.js';
import { DomainError } from '../shared/api.js';
import { inputHash } from './analysis.js';

/** Bounded single job. Callers own scheduling/readiness; there is no hidden loop. */
export async function processAnalysisOnce(services: { queue: AnalysisQueue; extraction: ExtractionPort; jev: JevPort }, options: { workerId: string; leaseMs: number; signal?: AbortSignal }): Promise<boolean> {
  const job = await services.queue.claim(options); if (!job) return false;
  const token = job.claimToken; // Immutable closure value, never looked up again after reclaim.
  try {
    const input = await services.queue.loadInput(job.id);
    let checkpoint = await services.queue.getExtraction(job.id);
    if (!checkpoint) {
      const result = await services.extraction.extract(input, options.signal);
      if (!result.ok) { await services.queue.fail(job.id, result, token); return true; }
      checkpoint = { jobId: job.id, extraction: result.value, provenance: result.provenance, inputHash: inputHash(input) };
      await services.queue.saveExtraction(checkpoint, token);
    }
    const decision = await services.jev.decide({ ...input, extraction: checkpoint.extraction }, options.signal);
    if (!decision.ok) { await services.queue.fail(job.id, decision, token); return true; }
    await services.queue.complete(job.id, decision.value, decision.provenance, token);
    return true;
  } catch (error) {
    // Fenced/stale callbacks never cancel or mutate a newer attempt. The next lease claim can recover.
    if (error instanceof DomainError && ['conflict', 'excluded_chat', 'not_found'].includes(error.code)) return true;
    // Transaction aborts, connection failures and unexpected infrastructure errors
    // remain recoverable. They are not evidence of a malformed model response.
    const invalid = error instanceof DomainError && error.code === 'validation';
    try { await services.queue.fail(job.id, { ok: false, code: invalid ? 'invalid_response' : 'unavailable', retryable: !invalid, retryAt: null, detail: invalid ? 'Analysis processing failed validation' : 'Analysis processing interrupted; durable retry required' }, token); }
    catch (failure) { if (!(failure instanceof DomainError)) throw failure; }
    return true;
  }
}
