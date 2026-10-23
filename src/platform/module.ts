import { z } from 'zod';
import { DomainError } from '../shared/api.js';
import { chatIdSchema, correctMappingSchema, idempotencyKeySchema, setInclusionSchema } from '../shared/schemas.js';
import type { HistoryCursor, ServiceStatus } from '../shared/domain.js';
import type { OperationsStatus, PlatformModule, RuntimeConfig } from '../shared/ports.js';
import { VikunjaAdapter } from '../vikunja/adapter.js';
import { configMetadata } from './config.js';
import { createMigrationGate } from './migration-gate.js';
import { migrate, PgDatabase } from './database.js';
import { MtcuteAdapter } from '../telegram/adapter.js';
import { ControlSetupManager, DurableControlBus } from '../telegram/control.js';
import { TelegramStore } from '../telegram/store.js';
import { TelegramSync } from '../telegram/sync.js';
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
  const db = new PgDatabase(config.databaseUrl), store = new TelegramStore(db, config.telegram), telegram = new MtcuteAdapter(config.telegram, store), vikunja = new VikunjaAdapter(config.vikunja, db);
  const migrationsReady = await createMigrationGate(db);
  telegram.setControlSetup(new ControlSetupManager(db, store, () => telegram.requireLive()));
  const control = new DurableControlBus(db, telegram, store, requireDatabaseReady), sync = new TelegramSync(db, store, telegram, control, config.telegram.historyBatchSize);
  let telegramStarted = false, telegramTask: Promise<void> | null = null;
  let dbState = state('connecting', 'database_pending', 'Waiting for database and migrations');
  let boardState: ServiceStatus | null = null;
  let migrationsDone = false, boardDone = false, stopped = false, started = false, permanentFailure = false;
  let task: Promise<void> | null = null, timer: ReturnType<typeof setTimeout> | null = null;
  async function requireDatabaseReady(): Promise<void> {
    if (!migrationsDone) throw new DomainError('upstream_unavailable', 'Database initialization is pending', true);
    try {
      const result = await migrationsReady();
      if (result === 'ready') { dbState = state('ready', null, 'PostgreSQL connected; current migration ledger checksums verified'); return; }
      dbState = result === 'drift'
        ? state('unavailable', 'migration_drift', 'Migration ledger differs from the application; business work is paused')
        : state('connecting', 'database_pending', 'Waiting for the complete checksum-validated migration ledger');
      throw new DomainError('upstream_unavailable', dbState.detail!, true);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      dbState = state('unavailable', 'database_unavailable', 'Database readiness unavailable; business work is paused');
      throw new DomainError('upstream_unavailable', dbState.detail!, true);
    }
  }
  async function initialize(): Promise<void> {
    try {
      if (stopped) return;
      if (!migrationsDone) { await migrate(db); migrationsDone = true; }
    } catch (error) {
      const migrationDrift = error instanceof Error && /Migration checksum mismatch|Missing applied migration/.test(error.message);
      permanentFailure = migrationDrift;
      dbState = state('unavailable', migrationDrift ? 'migration_drift' : 'database_unavailable', migrationDrift ? 'Applied migration differs from disk; restore the original migration before restarting' : 'Database or migrations unavailable; check PostgreSQL and runtime credentials');
      return;
    }
    if (stopped) return;
    try { await requireDatabaseReady(); } catch { return; }
    if (!telegramStarted) { telegramStarted = true; telegramTask = telegram.start().catch(() => {}).finally(() => { if (!stopped) sync.start(); }); }
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
    if (migrationsDone) { try { await requireDatabaseReady(); } catch { /* Status remains available with the failed gate state. */ } }
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
    return { components: { database: dbState, vikunja: boardState ?? await vikunja.status(), telegram: await telegram.status(), telegramSync: sync.status(), control: migrationsDone && dbState.state === 'ready' ? await control.status().catch(() => state('unavailable', 'control_status_unavailable', 'Control status query failed')) : state('connecting', 'database_pending', 'Control status awaits migrations'), extraction: configured(Boolean(config.extraction.apiKey), 'OpenAI'), jev: configured(Boolean(config.jev.apiKey), config.jev.provider === 'openai' ? 'OpenAI Decisions gpt-6-luna' : 'Vercel AI Gateway Jev') }, telegramLogin: await telegram.loginState(), accountBound, imports, replayPending, analysisPending, proposalsPending,
      configuration: { ...configMetadata(config), telegramConfigured: Boolean(config.telegram.apiId && config.telegram.apiHash), extractionConfigured: Boolean(config.extraction.apiKey), jevConfigured: Boolean(config.jev.apiKey) } };
  }
  return {
    name: 'platform', services: { db, config, clock: { now: () => new Date() }, telegram, vikunja, chats: store, ingestion: store, control },
    async register(app) {
      sync.register(); // subscriptions installed before any module starts
      const ready = requireDatabaseReady;
      const chatParams = z.strictObject({ chatId: chatIdSchema });
      app.get('/api/chats', async (req) => { await ready(); const input = z.strictObject({ cursor: z.string().max(500).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).parse(req.query); return store.list({ ...(input.cursor !== undefined ? { cursor: input.cursor } : {}), ...(input.limit !== undefined ? { limit: input.limit } : {}) }); });
      app.put('/api/chats/:chatId/inclusion', async (req) => { await ready(); return store.setInclusion(setInclusionSchema.parse({ ...(req.body as object), ...chatParams.parse(req.params) })); });
      app.get('/api/chats/:chatId/import', async (req) => { await ready(); return store.importStatus(chatParams.parse(req.params).chatId); });
      app.post('/api/chats/:chatId/import', async (req) => { await ready(); return store.requestImport(z.strictObject({ chatId: chatIdSchema, idempotencyKey: idempotencyKeySchema, maxBatches: z.number().int().min(1).max(10000), batchSize: z.number().int().min(1).max(100) }).parse({ ...(req.body as object), ...chatParams.parse(req.params) })); });
      app.get('/api/chats/:chatId/mapping', async (req) => { await ready(); return store.mappingCandidates(chatParams.parse(req.params).chatId); });
      app.put('/api/chats/:chatId/mapping', async (req) => { await ready(); return store.correctMapping(correctMappingSchema.parse({ ...(req.body as object), ...chatParams.parse(req.params), source: 'http' })); });
      app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(onboardingPage));
      app.get('/api/status', async (_req, reply) => reply.header('Cache-Control', 'no-store').send(await operationsStatus()));
      app.get('/api/telegram/login', async () => telegram.loginState());
      app.post('/api/telegram/login', async (req) => { const input = loginInput.parse(req.body); await ready(); return telegram.submitLogin(input); });
      app.post('/api/telegram/control-setup', async (req) => { await ready(); return telegram.configureControlChat(setupInput.parse(req.body)); });
      app.post('/api/telegram/control-setup/:operationKey/reconcile', async (req) => { await ready(); return telegram.reconcileControlSetup(z.strictObject({ operationKey: idempotencyKeySchema }).parse(req.params).operationKey); });
    },
    async start() { if (started || stopped) return; started = true; schedule(); },
    async stop() { if (stopped) return; stopped = true; if (timer) clearTimeout(timer); await sync.stop(); await telegram.stop(); await telegramTask; await task; await db.close(); },
    async status() {
      if (migrationsDone) { try { await requireDatabaseReady(); } catch { return dbState; } }
      if (dbState.state !== 'ready') return dbState;
      const board = boardState ?? await vikunja.status();
      if (board.state !== 'ready') return state('degraded', board.code, board.detail);
      const tg = await telegram.status();
      if (tg.state !== 'ready') return state('degraded', tg.code, tg.detail);
      const worker = sync.status();
      return worker.state === 'ready' ? state('ready', null, 'Platform services connected; durable import/replay status is visible separately') : worker;
    },
    operationsStatus,
  };
}
