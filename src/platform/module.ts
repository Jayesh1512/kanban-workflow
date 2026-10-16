import { z } from 'zod';
import { DomainError } from '../shared/api.js';
import { chatIdSchema, idempotencyKeySchema } from '../shared/schemas.js';
import type { HistoryCursor, ServiceStatus } from '../shared/domain.js';
import type { OperationsStatus, PlatformModule, RuntimeConfig } from '../shared/ports.js';
import { VikunjaAdapter } from '../vikunja/adapter.js';
import { configMetadata } from './config.js';
import { migrate, PgDatabase } from './database.js';
import { pendingChats, pendingControl, pendingIngestion, pendingTelegram } from './pending.js';
import { onboardingPage } from './page.js';

const loginInput = z.discriminatedUnion('step', [
  z.strictObject({ step: z.literal('phone'), phone: z.string().min(5).max(32) }),
  z.strictObject({ step: z.literal('code'), code: z.string().min(1).max(64) }),
  z.strictObject({ step: z.literal('password'), password: z.string().min(1).max(1024) }),
]);
const setupInput = z.union([
  z.strictObject({ operationKey: idempotencyKeySchema, chatId: chatIdSchema }),
  z.strictObject({ operationKey: idempotencyKeySchema, createPrivateSupergroup: z.literal(true), title: z.string().min(1).max(128) }),
]);
const state = (value: ServiceStatus['state'], code: string | null, detail: string | null): ServiceStatus => ({ state: value, code, detail, checkedAt: new Date().toISOString() });
const safeCount = (raw: unknown): number => {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Unsafe count');
  return n;
};

export async function createPlatformModule(config: RuntimeConfig): Promise<PlatformModule> {
  // Constructors allocate no open connection, session, timer or remote action.
  const db = new PgDatabase(config.databaseUrl), telegram = pendingTelegram(), vikunja = new VikunjaAdapter(config.vikunja, db);
  let dbState = state('connecting', 'database_pending', 'Waiting for database and migrations');
  let boardState: ServiceStatus | null = null;
  let migrationsDone = false, boardDone = false, stopped = false, started = false, permanentFailure = false;
  let task: Promise<void> | null = null, timer: ReturnType<typeof setTimeout> | null = null;
  async function initialize(): Promise<void> {
    try {
      await db.query('SELECT 1');
      if (stopped) return;
      if (!migrationsDone) { await migrate(db); migrationsDone = true; }
      dbState = state('ready', null, 'PostgreSQL connected; migration checksums verified');
    } catch (error) {
      const migrationDrift = error instanceof Error && /Migration checksum mismatch|Missing applied migration/.test(error.message);
      permanentFailure = migrationDrift;
      dbState = state('unavailable', migrationDrift ? 'migration_drift' : 'database_unavailable', migrationDrift ? 'Applied migration differs from disk; restore the original migration before restarting' : 'Database or migrations unavailable; check PostgreSQL and runtime credentials');
      return;
    }
    if (stopped) return;
    try {
      if (!boardDone) { await vikunja.ensureBoard(); boardDone = true; } else await vikunja.check();
      boardState = await vikunja.status();
    } catch (error) {
      const known = error instanceof DomainError ? error : null;
      boardState = state(known?.code === 'not_configured' ? 'unconfigured' : 'unavailable', known?.code ?? 'vikunja_bootstrap_failed', known?.message ?? 'Vikunja board bootstrap failed; check database and service health');
      boardDone = false;
    }
  }
  function schedule(): void {
    if (stopped || permanentFailure) return;
    task = initialize().finally(() => {
      task = null;
      if (!stopped && !permanentFailure) { timer = setTimeout(schedule, 5_000); timer.unref(); }
    });
  }
  async function operationsStatus(): Promise<OperationsStatus> {
    let imports: HistoryCursor[] = [], accountBound = false, replayPending = 0, analysisPending = 0, proposalsPending = 0;
    if (migrationsDone && dbState.state === 'ready') {
      try {
        const counts = (await db.query<{ account: boolean; replay: string; analysis: string; proposals: string }>(`SELECT EXISTS(SELECT 1 FROM telegram_account) AS account,
          (SELECT count(*) FROM live_checkpoints WHERE replay_required) AS replay,
          (SELECT count(*) FROM analysis_jobs WHERE status IN ('pending','running','retry','provider_unavailable')) AS analysis,
          (SELECT count(*) FROM proposals WHERE decision='pending' OR apply_state IN ('queued','applying','reconciling')) AS proposals`)).rows[0];
        if (counts) {
          accountBound = counts.account;
          replayPending = safeCount(counts.replay); analysisPending = safeCount(counts.analysis); proposalsPending = safeCount(counts.proposals);
        }
        const cursors = await db.query('SELECT * FROM history_cursors ORDER BY updated_at DESC LIMIT 200');
        imports = cursors.rows.map((r) => ({ chatId: String(r['chat_id']), nextMessageId: r['next_message_id'] as number | null, nextDate: r['next_date'] ? (r['next_date'] as Date).toISOString() : null, status: r['status'] as HistoryCursor['status'], importedCount: safeCount(r['imported_count']), generation: r['generation'] as number, leaseUntil: r['lease_until'] ? (r['lease_until'] as Date).toISOString() : null, lastError: r['last_error'] ? 'Import failed; retry after checking the Telegram connection' : null, updatedAt: (r['updated_at'] as Date).toISOString() }));
      } catch { dbState = state('unavailable', 'database_unavailable', 'Database status query failed; retrying connection'); }
    }
    const configured = (present: boolean, name: string) => state(present ? 'degraded' : 'unconfigured', present ? 'not_checked' : 'missing_credentials', present ? `${name} configured; access has not been verified by the workflow module` : `Configure ${name} runtime credentials`);
    return { components: { database: dbState, vikunja: boardState ?? await vikunja.status(), telegram: await telegram.status(), extraction: configured(Boolean(config.extraction.apiKey), 'OpenAI'), jev: configured(Boolean(config.jev.apiKey), 'Vercel AI Gateway Jev') }, telegramLogin: await telegram.loginState(), accountBound, imports, replayPending, analysisPending, proposalsPending,
      configuration: { ...configMetadata(config), telegramConfigured: Boolean(config.telegram.apiId && config.telegram.apiHash), extractionConfigured: Boolean(config.extraction.apiKey), jevConfigured: Boolean(config.jev.apiKey) } };
  }
  return {
    name: 'platform', services: { db, config, clock: { now: () => new Date() }, telegram, vikunja, chats: pendingChats(), ingestion: pendingIngestion(), control: pendingControl() },
    async register(app) {
      app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(onboardingPage));
      app.get('/api/status', async (_req, reply) => reply.header('Cache-Control', 'no-store').send(await operationsStatus()));
      app.get('/api/telegram/login', async () => telegram.loginState());
      app.post('/api/telegram/login', async (req) => telegram.submitLogin(loginInput.parse(req.body)));
      app.post('/api/telegram/control-setup', async (req) => telegram.configureControlChat(setupInput.parse(req.body)));
      app.post('/api/telegram/control-setup/:operationKey/reconcile', async (req) => telegram.reconcileControlSetup(z.strictObject({ operationKey: idempotencyKeySchema }).parse(req.params).operationKey));
    },
    async start() { if (started || stopped) return; started = true; schedule(); },
    async stop() { if (stopped) return; stopped = true; if (timer) clearTimeout(timer); await task; await telegram.stop(); await db.close(); },
    async status() {
      if (dbState.state !== 'ready') return dbState;
      const board = boardState ?? await vikunja.status();
      if (board.state !== 'ready') return state('degraded', board.code, board.detail);
      return state('degraded', 'telegram_m2_pending', 'Database and Vikunja ready; Telegram onboarding and synchronization require M2');
    },
    operationsStatus,
  };
}
