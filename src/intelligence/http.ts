import type { Clock, ProviderResult } from '../shared/ports.js';
import type { ServiceStatus } from '../shared/domain.js';

export type ProviderFailure = Extract<ProviderResult<never>, { ok: false }>;
export interface HttpOptions { fetch?: typeof fetch; clock?: Clock; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> }
export type HttpConfig = { apiKey: string | null; timeoutMs: number; maxAttempts: number };
const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(new Error('Cancelled')); return; }
  const timer = setTimeout(done, ms);
  function abort() { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('Cancelled')); }
  function done() { signal?.removeEventListener('abort', abort); resolve(); }
  signal?.addEventListener('abort', abort, { once: true });
});

/** Error details intentionally contain no reflected upstream body or exception text. */
export class ProviderHttp {
  readonly clock: Clock;
  private latest: ServiceStatus;
  constructor(private config: HttpConfig, private options: HttpOptions = {}) {
    this.clock = options.clock ?? { now: () => new Date() };
    this.latest = this.makeStatus(config.apiKey ? 'connecting' : 'unconfigured', config.apiKey ? 'not_checked' : 'missing_key');
  }
  private makeStatus(state: ServiceStatus['state'], code: string | null): ServiceStatus { return { state, code, detail: null, checkedAt: this.clock.now().toISOString() }; }
  status(): ServiceStatus { return { ...this.latest }; }
  invalid(): ProviderFailure { const result: ProviderFailure = { ok: false, code: 'invalid_response', retryable: false, retryAt: null, detail: 'Provider response failed contract or evidence validation' }; this.latest = this.makeStatus('degraded', result.code); return result; }
  async post(endpoint: string, body: unknown, signal?: AbortSignal): Promise<{ ok: true; data: unknown; requestId: string | null } | ProviderFailure> {
    if (!this.config.apiKey?.trim()) return { ok: false, code: 'unconfigured', retryable: false, retryAt: null, detail: 'Provider credential is not configured' };
    const attempts = Math.min(5, Math.max(1, this.config.maxAttempts));
    for (let attempt = 0; attempt < attempts; attempt++) {
      const timed = AbortSignal.timeout(Math.max(1, this.config.timeoutMs));
      const combined = signal ? AbortSignal.any([signal, timed]) : timed;
      let failure: ProviderFailure;
      try {
        const response = await (this.options.fetch ?? fetch)(endpoint, { method: 'POST', redirect: 'error', signal: combined,
          headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!response.ok) {
          const code: ProviderFailure['code'] = [401, 402, 403].includes(response.status) ? 'entitlement' : response.status === 429 ? 'rate_limited' : response.status >= 500 ? 'unavailable' : 'invalid_response';
          const retryAfter = response.headers.get('retry-after');
          const seconds = retryAfter === null ? NaN : Number(retryAfter);
          const retryTime = Number.isFinite(seconds) ? this.clock.now().getTime() + Math.max(0, seconds) * 1000 : Date.parse(retryAfter ?? '');
          failure = { ok: false, code, retryable: response.status === 429 || response.status >= 500,
            retryAt: Number.isFinite(retryTime) ? new Date(retryTime).toISOString() : null,
            detail: `Provider HTTP ${response.status}${code === 'entitlement' ? ': model access or credential unavailable' : ''}` };
          await response.body?.cancel();
        } else {
          const reader = response.body?.getReader();
          if (!reader) return this.invalid();
          const chunks: Uint8Array[] = []; let size = 0;
          try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2_000_000) { await reader.cancel(); return this.invalid(); } chunks.push(value); } }
          finally { reader.releaseLock(); }
          let data: unknown; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return this.invalid(); }
          const rawId = response.headers.get('x-request-id') ?? response.headers.get('x-typesafe-request-id');
          const requestId = rawId && /^[A-Za-z0-9_-]{1,160}$/.test(rawId) && !rawId.includes(this.config.apiKey) ? rawId : null;
          this.latest = this.makeStatus('ready', null); return { ok: true, data, requestId };
        }
      } catch {
        failure = { ok: false, code: timed.aborted || signal?.aborted ? 'timeout' : 'unavailable', retryable: !signal?.aborted, retryAt: null, detail: signal?.aborted ? 'Provider request cancelled' : timed.aborted ? 'Provider request timed out' : 'Provider connection unavailable' };
      }
      this.latest = this.makeStatus('unavailable', failure.code);
      if (!failure.retryable || attempt + 1 >= attempts || signal?.aborted) return failure;
      const wait = failure.retryAt ? Math.max(0, Date.parse(failure.retryAt) - this.clock.now().getTime()) : 100 * 2 ** attempt;
      // Long rate-limit delays belong to the durable queue, never an unbounded request loop.
      if (wait > Math.min(this.config.timeoutMs, 5000)) return failure;
      try { await (this.options.sleep ?? defaultSleep)(wait, signal); } catch { return failure; }
    }
    return this.invalid();
  }
}
