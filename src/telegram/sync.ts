import { randomUUID } from 'node:crypto';
import { tl } from '@mtcute/node';
import { DomainError } from '../shared/api.js';
import type { ServiceStatus } from '../shared/domain.js';
import type { TelegramEvent } from '../shared/ports.js';
import type { PgDatabase } from '../platform/database.js';
import type { MtcuteAdapter } from './adapter.js';
import type { DurableControlBus } from './control.js';
import { TelegramStore } from './store.js';

type Phase = 'history' | 'replay' | 'recent' | 'control';
const retryPrefix = 'telegram:sync-retry:';
const retryKey = (chatId: string, phase: Phase) => `${retryPrefix}${phase}:${chatId}`;
// Only known peer access faults are isolated. Auth, flood, network, unexpected
// protocol failures and every SQL/storage error retain global backoff.
const chatAccessFault = (error: unknown) => tl.RpcError.is(error) && /^(CHANNEL_PRIVATE|CHANNEL_INVALID|CHANNEL_PUBLIC_GROUP_NA|CHAT_FORBIDDEN|CHAT_ID_INVALID|CHAT_ADMIN_REQUIRED|PEER_ID_INVALID|USER_BANNED_IN_CHANNEL)$/.test(error.text);

/** Bounded remote work. No SQL transaction spans Telegram I/O. */
export class TelegramSync {
  private readonly workerId = `telegram:${randomUUID()}`;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;
  private nextDiscovery = Date.now() + 60_000;
  private retryAt = 0;
  private globalFailures = 0;
  private component: ServiceStatus = { state: 'unconfigured', code: 'login_required', detail: 'Connect Telegram to start import/replay', checkedAt: new Date().toISOString() };
  constructor(private readonly db: PgDatabase, private readonly store: TelegramStore, private readonly telegram: MtcuteAdapter, private readonly control: DurableControlBus, private readonly batchSize = 100) {}
  register(): void { this.unsubscribe ??= this.telegram.subscribe((event) => this.accept(event)); }
  private async accept(event: TelegramEvent): Promise<void> {
    if (event.type === 'message' || event.type === 'edit') {
      if (!(await this.db.query('SELECT 1 FROM chats WHERE id=$1', [event.message.chatId])).rowCount) await this.store.upsertDialog(await this.telegram.describe(event.message.chatId));
    }
    await this.store.ingest(event);
  }
  status(): ServiceStatus { return this.component; }
  start(): void {
    if (this.active || this.timer || this.stopped) return;
    const schedule = () => {
      if (this.stopped) return;
      this.active = this.tick().catch(() => {}).finally(() => { this.active = null; if (!this.stopped) { this.timer = setTimeout(() => { this.timer = null; schedule(); }, 1_000); this.timer.unref(); } });
    };
    schedule();
  }
  private async due(chatId: string, phase: Phase): Promise<boolean> {
    return !(await this.db.query("SELECT 1 FROM app_settings WHERE key=$1 AND (value->>'retryAt')::timestamptz>now()", [retryKey(chatId, phase)])).rowCount;
  }
  private async isolated(chatId: string, phase: Phase, work: () => Promise<void>): Promise<boolean> {
    try {
      await work();
      await this.db.query('DELETE FROM app_settings WHERE key=$1', [retryKey(chatId, phase)]);
      return true;
    } catch (error) {
      if (error instanceof DomainError && error.code === 'conflict') return false;
      if (!chatAccessFault(error)) throw error;
      // Existing durable settings hold only sanitized peer scheduling metadata;
      // failed RPCs never alter successful coverage checkpoints or message data.
      await this.db.query(`INSERT INTO app_settings(key,value) VALUES($1,jsonb_build_object('chatId',$2::text,'phase',$3::text,'attempts',1,'error',$4::text,'retryAt',now()+interval '30 seconds'))
        ON CONFLICT(key) DO UPDATE SET value=jsonb_build_object('chatId',$2::text,'phase',$3::text,'attempts',LEAST((app_settings.value->>'attempts')::integer+1,1000000),'error',$4::text,
        'retryAt',now()+LEAST(300,30*power(2,LEAST((app_settings.value->>'attempts')::integer,4)))*interval '1 second'),updated_at=now()`, [retryKey(chatId, phase), chatId, phase, tl.RpcError.is(error) ? error.text : 'chat_unavailable']);
      return false;
    }
  }
  private async refreshStatus(): Promise<void> {
    const failed = (await this.db.query(`SELECT s.value,count(*) OVER() AS total FROM app_settings s JOIN chats c ON c.id::text=s.value->>'chatId'
      WHERE s.key LIKE 'telegram:sync-retry:%' AND ((s.value->>'phase'='control' AND c.is_control) OR (s.value->>'phase'<>'control' AND c.inclusion='included' AND NOT c.is_control)) ORDER BY s.updated_at,s.key LIMIT 5`)).rows;
    const detail = failed.map((r) => { const v = r['value'] as Record<string, unknown>; return `${v['chatId']} ${v['phase']}: ${v['error']}, retry ${v['retryAt']}`; }).join('; ');
    this.component = { state: failed.length ? 'degraded' : 'ready', code: failed.length ? 'telegram_chat_retry' : null,
      detail: failed.length ? `${failed[0]!['total']} chat phases retained for retry; ${detail}` : 'Bounded history/replay and durable control delivery workers running; inspect pending counts for coverage', checkedAt: new Date().toISOString() };
  }
  /** One history page, one replay page and one control batch per turn. */
  async tick(): Promise<void> {
    if (this.stopped || Date.now() < this.retryAt || (await this.telegram.loginState()).state !== 'ready') return;
    try {
      await this.work(); this.globalFailures = 0; this.retryAt = 0; await this.refreshStatus();
    } catch (error) {
      const seconds = tl.RpcError.is(error) && 'seconds' in error ? Number(error.seconds) : 0;
      const floodDelay = Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1000 : 0;
      const delay = Math.max(Math.min(300_000, 10_000 * 2 ** Math.min(this.globalFailures++, 5)), floodDelay);
      this.retryAt = Date.now() + delay;
      this.component = { state: 'degraded', code: 'telegram_sync_retry', detail: `Global Telegram/network/storage failure; synchronization retained for retry after ${new Date(this.retryAt).toISOString()}`, checkedAt: new Date().toISOString() };
      throw error;
    }
  }
  private async work(): Promise<void> {
    await this.control.tick(); if (this.stopped) return;
    if (Date.now() >= this.nextDiscovery) {
      this.nextDiscovery = Date.now() + 60_000;
      for await (const dialog of this.telegram.discoverDialogs()) { if (this.stopped) return; await this.store.upsertDialog(dialog); }
    }
    await this.controlReplay(); if (this.stopped) return;
    const history = (await this.db.query(`SELECT c.id,c.policy_version,r.batch_size FROM chats c JOIN history_cursors h ON h.chat_id=c.id JOIN telegram_history_requests r ON r.chat_id=c.id
      WHERE c.inclusion='included' AND NOT c.is_control AND r.remaining_batches>0 AND h.status IN ('pending','running','error') AND (h.lease_until IS NULL OR h.lease_until<now())
      AND NOT EXISTS(SELECT 1 FROM app_settings a WHERE a.key='telegram:sync-retry:history:'||c.id::text AND (a.value->>'retryAt')::timestamptz>now()) ORDER BY h.updated_at,c.id LIMIT 1`)).rows[0];
    if (history) {
      const chatId = String(history['id']), cursor = await this.store.claimHistory(chatId, this.workerId, 30_000);
      if (cursor) {
        const success = await this.isolated(chatId, 'history', async () => { await this.store.commitHistoryBatch(chatId, Number(history['policy_version']), cursor.generation, await this.telegram.getHistory(chatId, cursor, Number(history['batch_size']))); });
        if (!success) await this.db.query("UPDATE history_cursors SET status='error',last_error='History access unavailable; cursor retained for retry',worker_id=NULL,lease_until=NULL,updated_at=now() WHERE chat_id=$1 AND generation=$2", [chatId, cursor.generation]);
      }
    }
    if (this.stopped) return;
    const replay = (await this.db.query(`SELECT c.id,c.policy_version FROM chats c JOIN live_checkpoints l ON l.chat_id=c.id
      WHERE c.inclusion='included' AND NOT c.is_control AND (l.replay_required OR l.reconciled_at IS NULL OR l.reconciled_at<now()-interval '60 seconds')
      AND NOT EXISTS(SELECT 1 FROM app_settings a WHERE a.key='telegram:sync-retry:replay:'||c.id::text AND (a.value->>'retryAt')::timestamptz>now()) ORDER BY l.reconciled_at NULLS FIRST,c.id LIMIT 1`)).rows[0];
    if (replay) {
      const chatId = String(replay['id']), checkpoint = await this.store.getLiveCheckpoint(chatId);
      const success = await this.isolated(chatId, 'replay', async () => {
        // New coverage begins at a bounded head window; older history has its own budget.
        const messages = checkpoint.highWaterMessageId === null
          ? (await this.telegram.getHistory(chatId, { ...(await this.store.getCursor(chatId)), nextMessageId: null, nextDate: null }, this.batchSize)).messages
          : await this.telegram.replayPage(chatId, checkpoint.highWaterMessageId, this.batchSize);
        await this.store.commitReplay({ chatId, expectedPolicyVersion: Number(replay['policy_version']), expectedGeneration: checkpoint.generation, messages, highWaterMessageId: Math.max(checkpoint.highWaterMessageId ?? 0, ...messages.map((m) => m.id)) || null });
      });
      if (success && await this.due(chatId, 'recent')) await this.isolated(chatId, 'recent', () => this.reconcileRecent(chatId));
    }
  }
  private async reconcileRecent(chatId: string): Promise<void> {
    const ids = (await this.db.query('SELECT id FROM messages WHERE chat_id=$1 AND deleted_at IS NULL ORDER BY id DESC LIMIT $2', [chatId, this.batchSize])).rows.map((r) => Number(r['id']));
    if (!ids.length) return;
    const remote = await this.telegram.recent(chatId, ids);
    if (remote.length !== ids.length) throw new Error('Unexpected Telegram reconciliation cardinality');
    for (let i = 0; i < ids.length; i++) {
      const message = remote[i];
      await this.store.ingest(message ? { type: 'edit', message } : { type: 'delete', chatId, messageIds: [ids[i]!], observedAt: new Date().toISOString() });
    }
  }
  private async controlReplay(): Promise<void> {
    const chat = (await this.db.query('SELECT id FROM chats WHERE is_control')).rows[0]; if (!chat) return;
    const chatId = String(chat['id']); if (!await this.due(chatId, 'control')) return;
    await this.isolated(chatId, 'control', async () => {
      const key = `telegram:control-replay:${chatId}`;
      const saved = (await this.db.query('SELECT value FROM app_settings WHERE key=$1', [key])).rows[0]?.['value'];
      const prior = typeof saved === 'number' ? saved : null;
      const messages = prior === null
        ? (await this.telegram.getHistory(chatId, { chatId, nextMessageId: null, nextDate: null, status: 'pending', importedCount: 0, lastError: null, updatedAt: new Date().toISOString(), generation: 0, leaseUntil: null }, this.batchSize)).messages
        : await this.telegram.replayPage(chatId, prior, this.batchSize);
      for (const message of messages) await this.store.ingest({ type: 'message', message });
      const max = Math.max(prior ?? 0, ...messages.map((m) => m.id));
      if (max) await this.db.query('INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=to_jsonb(GREATEST((app_settings.value)::text::bigint,$3::bigint)),updated_at=now()', [key, JSON.stringify(max), max]);
    });
  }
  async stop(): Promise<void> { this.stopped = true; if (this.timer) clearTimeout(this.timer); await this.active; this.unsubscribe?.(); this.unsubscribe = null; }
}
