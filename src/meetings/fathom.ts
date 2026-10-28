import { z } from 'zod';
import type { Clock } from '../shared/ports.js';
import type { FathomMeeting, FathomPage } from './domain.js';

const nullableText = z.string().nullable().optional();
const instant = z.string().datetime({ offset: true });
const optionalInstant = instant.nullable().optional();
const relativeTime = z.string().regex(/^\d{2,}:\d{2}:\d{2}$/);
/** Inclusion fields remain optional: absence must never be normalized to an empty set. */
export const fathomMeetingSchema: z.ZodType<FathomMeeting> = z.object({
  recording_id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), title: z.string(), created_at: instant,
  meeting_title: nullableText, meeting_type: nullableText, url: nullableText, share_url: nullableText,
  transcript_language: nullableText, scheduled_start_time: optionalInstant, scheduled_end_time: optionalInstant,
  recording_start_time: optionalInstant, recording_end_time: optionalInstant,
  recorded_by: z.object({ name: nullableText, email: nullableText, email_domain: nullableText, team: nullableText }).passthrough().nullable().optional(),
  calendar_invitees: z.array(z.object({ name: nullableText, email: nullableText, email_domain: nullableText, is_external: z.boolean() }).passthrough()).optional(),
  transcript: z.array(z.object({ speaker: z.object({ display_name: z.string(), matched_calendar_invitee_email: nullableText }).passthrough(), text: z.string(), timestamp: relativeTime }).passthrough()).nullable().optional(),
  default_summary: z.object({ template_name: nullableText, markdown_formatted: z.string().nullable() }).passthrough().nullable().optional(),
  action_items: z.array(z.object({ description: z.string(), completed: z.boolean(), user_generated: z.boolean().optional(),
    recording_timestamp: relativeTime.nullable().optional(), recording_playback_url: nullableText,
    assignee: z.object({ name: z.string().nullable(), email: z.string().nullable(), team: nullableText }).passthrough().nullable().optional(),
  }).passthrough()).nullable().optional(),
}).passthrough() as unknown as z.ZodType<FathomMeeting>;
// Live Fathom responses also use an empty string to mark the terminal page.
const pageSchema = z.object({ items: z.array(fathomMeetingSchema), next_cursor: z.string().nullable().transform(cursor => cursor === '' ? null : cursor), limit: z.number().int().positive().nullable().optional() }).passthrough();

export class FathomError extends Error {
  constructor(public readonly code: 'authentication' | 'rate_limited' | 'unavailable' | 'invalid_response' | 'timeout' | 'aborted', message: string,
    public readonly retryAfterMs: number | null = null, public readonly status: number | null = null) { super(message); this.name = 'FathomError'; }
}
export interface FathomListInput { createdAfter: string; createdBefore: string; cursor?: string | null }
export interface FathomClientOptions { apiKey: string; timeoutMs?: number; fetch?: typeof fetch; clock?: Clock; baseUrl?: string }
export class FathomClient {
  private readonly request: typeof fetch;
  private readonly clock: Clock;
  constructor(private readonly options: FathomClientOptions) { this.request = options.fetch ?? fetch; this.clock = options.clock ?? { now: () => new Date() }; }
  async listMeetings(input: FathomListInput, signal?: AbortSignal): Promise<FathomPage> {
    const url = new URL('meetings', (this.options.baseUrl ?? 'https://api.fathom.ai/external/v1/').replace(/\/?$/, '/'));
    url.searchParams.set('include_transcript', 'true'); url.searchParams.set('include_summary', 'true');
    url.searchParams.set('include_action_items', 'true'); url.searchParams.set('include_crm_matches', 'true');
    url.searchParams.set('created_after', input.createdAfter); url.searchParams.set('created_before', input.createdBefore);
    if (input.cursor) url.searchParams.set('cursor', input.cursor);
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Fathom request timeout')), this.options.timeoutMs ?? 30_000);
    try {
      const response = await this.request(url, { headers: { 'X-Api-Key': this.options.apiKey, Accept: 'application/json' }, redirect: 'error', signal: controller.signal });
      if (!response.ok) {
        // Never include provider response bodies or credential-bearing URLs in diagnostics.
        if (response.status === 401 || response.status === 403) throw new FathomError('authentication', 'Fathom API authentication failed', null, response.status);
        const retry = retryAfter(response.headers.get('retry-after'), this.clock.now());
        throw new FathomError(response.status === 429 ? 'rate_limited' : 'unavailable', `Fathom API returned HTTP ${response.status}`, retry, response.status);
      }
      let body: unknown;
      try { body = await response.json(); } catch { throw new FathomError('invalid_response', 'Fathom returned invalid JSON'); }
      const parsed = pageSchema.safeParse(body);
      if (!parsed.success) throw new FathomError('invalid_response', 'Fathom returned an invalid meetings page');
      return parsed.data as { items: FathomMeeting[]; next_cursor: string | null; limit?: number | null };
    } catch (error) {
      if (signal?.aborted) throw new FathomError('aborted', 'Fathom request canceled');
      if (controller.signal.aborted) throw new FathomError('timeout', 'Fathom request timed out');
      if (error instanceof FathomError) throw error;
      throw new FathomError('unavailable', 'Fathom API is unavailable');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
}
function retryAfter(value: string | null, now: Date): number | null {
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const delay = Number(value) * 1000;
    return Number.isFinite(delay) && Number.isFinite(new Date(now.getTime() + delay).getTime()) ? delay : null;
  }
  const date = Date.parse(value); return Number.isFinite(date) ? Math.max(date - now.getTime(), 0) : null;
}
