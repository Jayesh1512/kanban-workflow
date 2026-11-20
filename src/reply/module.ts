import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApplicationModule, PlatformServices, ReplyAgentConfig } from '../shared/ports.js';
import type { ServiceStatus } from '../shared/domain.js';
import { DomainError } from '../shared/api.js';
import { canMoveCrm } from '../access/service.js';
import { createOpenAIReplyAnalyzer } from './analyzer.js';
import { ReplyAgent } from './agent.js';

const defaults: ReplyAgentConfig = {
  enabled: true, intervalMs: 3_600_000, maxChats: 25, contextMessages: 15, windowMinutes: 60,
  ownerNames: ['Ravi', 'Ravikant'], digestChatId: 'self',
};

/**
 * Hourly reply drafting. It reads Telegram group history for the connected
 * account and stores drafts. It does not touch CRM intake, proposals, approvals
 * or the board, and it never sends to a source group.
 */
export async function createReplyModule(platform: PlatformServices): Promise<ApplicationModule> {
  const config = platform.config.reply ?? defaults;
  const analyzer = createOpenAIReplyAnalyzer(platform.config.extraction, { clock: platform.clock });
  const agent = new ReplyAgent(platform.db, platform.telegram, analyzer, { ...config, timezone: platform.config.timezone, now: () => platform.clock.now() });
  let timer: ReturnType<typeof setTimeout> | null = null;
  let task: Promise<void> | null = null;
  let inFlight: AbortController | null = null;
  let started = false, stopped = false;
  let state: ServiceStatus = { state: 'connecting', code: 'not_started', detail: 'Reply agent has not started', checkedAt: platform.clock.now().toISOString() };
  const at = () => platform.clock.now().toISOString();

  async function migrationsReady(): Promise<boolean> {
    try {
      const row = (await platform.db.query<{ present: boolean }>("SELECT to_regclass(quote_ident(current_schema())||'.reply_scans') IS NOT NULL AS present")).rows[0];
      return Boolean(row?.present);
    } catch { return false; }
  }
  async function planDelay(): Promise<number> {
    const last = await agent.lastRunAt();
    if (!last) return 0;
    const elapsed = platform.clock.now().getTime() - Date.parse(last);
    return Number.isFinite(elapsed) ? Math.max(5_000, config.intervalMs - elapsed) : 0;
  }
  function arm(delay: number): void {
    if (stopped) return;
    timer = setTimeout(run, delay);
    timer.unref();
  }
  function run(): void {
    if (stopped) return;
    let ready = false;
    inFlight = new AbortController();
    task = (async () => {
      try {
        if (await migrationsReady()) {
          ready = true;
          const summary = await agent.scanOnce('scheduled', inFlight?.signal);
          state = agent.status();
          if (summary.chats === 0) state = { ...state, detail: `${state.detail ?? ''} No eligible groups discovered yet`.trim(), checkedAt: at() };
        } else {
          state = { state: 'connecting', code: 'database_pending', detail: 'Reply agent awaits database migrations', checkedAt: at() };
        }
      } catch (error) {
        state = { state: 'degraded', code: 'reply_scan_retry', detail: `Reply scan failed; retry in ${Math.round(config.intervalMs / 60_000)} minutes: ${error instanceof Error ? error.message.slice(0, 160) : 'unknown error'}`, checkedAt: at() };
      }
    })().catch(() => {}).finally(() => {
      task = null;
      inFlight = null;
      // Retry sooner while migrations are pending; the ledger can settle within seconds.
      if (!stopped) arm(ready ? config.intervalMs : 60_000);
    });
  }

  const guard = (app: FastifyInstance) => {
    const access = app.workspaceAccess;
    if (!access) return undefined;
    // Read access follows CRM management: suggestions quote private group messages.
    const check = (request: FastifyRequest) => { if (!canMoveCrm(access.user(request))) throw new DomainError('forbidden', 'CRM management permission is required'); };
    return check;
  };

  return {
    name: 'reply',
    async register(app) {
      const check = guard(app);
      app.get('/api/reply/suggestions', async (request) => {
        check?.(request);
        if (!(await migrationsReady())) throw new DomainError('upstream_unavailable', 'Reply agent awaits database migrations', true);
        const input = z.strictObject({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.iso.datetime().optional() }).parse(request.query);
        const rows = (await platform.db.query(`SELECT id::text AS id, chat_id::text AS chat_id, chat_title, trigger_message_id, message_count,
          addressed_to, urgency, relevance_reason, suggested_text, created_at, delivered_at, delivery_message_id, delivery_error
          FROM reply_suggestions
          WHERE ($1::timestamptz IS NULL OR created_at < $1::timestamptz)
          ORDER BY created_at DESC, id DESC LIMIT $2`, [input.before ?? null, input.limit])).rows;
        return { items: rows, nextBefore: rows.length === input.limit ? (rows.at(-1)?.['created_at'] as Date).toISOString() : null };
      });
      app.get('/api/reply/status', async (request) => {
        check?.(request);
        return { ...agent.status(), configuration: { enabled: config.enabled, intervalMs: config.intervalMs, maxChats: config.maxChats, contextMessages: config.contextMessages, windowMinutes: config.windowMinutes, ownerNames: config.ownerNames, digestChatId: config.digestChatId === 'off' ? 'off' : config.digestChatId === 'self' ? 'self' : 'configured' } };
      });
      app.post('/api/reply/scan', async (request) => {
        check?.(request);
        // A manual scan is a Telegram worker action; only the primary process owns it.
        if (platform.config.role === 'web') throw new DomainError('forbidden', 'Reply scans run on the primary process');
        if (stopped) throw new DomainError('upstream_unavailable', 'Reply agent is stopping', true);
        if (!(await migrationsReady())) throw new DomainError('upstream_unavailable', 'Reply agent awaits database migrations', true);
        const summary = await agent.scanOnce('manual');
        state = agent.status();
        return summary;
      });
    },
    async start() {
      if (started || stopped) return;
      started = true;
      if (platform.config.role === 'web') { state = { state: 'ready', code: null, detail: 'Web role: reply worker runs on the primary process', checkedAt: at() }; return; }
      if (!config.enabled) { state = { state: 'ready', code: null, detail: 'Reply agent disabled by configuration', checkedAt: at() }; return; }
      state = { state: 'connecting', code: 'scheduled', detail: `Reply agent armed; next scan within ${Math.round(config.intervalMs / 60_000)} minutes`, checkedAt: at() };
      arm(await planDelay());
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      // Cancel the in-flight provider call so shutdown stays inside its grace period.
      inFlight?.abort();
      await task;
    },
    async status() { return { ...state }; },
  };
}
