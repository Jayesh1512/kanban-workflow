import type { ApplicationModule, PlatformServices } from '../shared/ports.js';
import { createOpenAIExtractor } from '../intelligence/openai.js';
import { createJevAdapter } from '../intelligence/jev.js';
import { SqlAnalysisQueue } from './analysis.js';
import { RecordsRepository } from './records.js';
import { processAnalysisOnce } from './processor.js';

export function createWorkflowServices(platform: PlatformServices) {
  const records = new RecordsRepository(platform.db, platform.clock, platform.config.timezone);
  const analysis = new SqlAnalysisQueue(platform.db, platform.clock, platform.config.timezone);
  const extraction = createOpenAIExtractor(platform.config.extraction, { clock: platform.clock });
  const jev = createJevAdapter(platform.config.jev, { clock: platform.clock });
  return { records, analysis, extraction, jev,
    processOnce: (options: { workerId: string; leaseMs: number; signal?: AbortSignal }) => processAnalysisOnce({ queue: analysis, extraction, jev }, options) };
}

/** M3.1 allocates services only. PM wires scheduling after platform registration/readiness. */
export async function createWorkflowModule(platform: PlatformServices): Promise<ApplicationModule> {
  const services = createWorkflowServices(platform); let started = false;
  return {
    name: 'workflow',
    async register() {},
    async start() { started = true; },
    async stop() { started = false; },
    async status() {
      const statuses = await Promise.all([services.extraction.status(), services.jev.status()]);
      return { state: 'degraded', code: started ? 'm31_manual_dispatch' : 'not_started',
        detail: statuses.some((s) => s.state === 'unavailable') ? 'Provider unavailable; pending analysis retained' : 'M3.1 services available; worker scheduling and proposal application await integration',
        checkedAt: platform.clock.now().toISOString() };
    },
  };
}
