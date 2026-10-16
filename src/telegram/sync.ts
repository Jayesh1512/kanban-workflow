import { randomUUID } from 'node:crypto';
import { tl } from '@mtcute/node';
import { DomainError } from '../shared/api.js';
import type { ServiceStatus } from '../shared/domain.js';
import type { TelegramEvent } from '../shared/ports.js';
import type { PgDatabase } from '../platform/database.js';
import type { MtcuteAdapter } from './adapter.js';
import type { DurableControlBus } from './control.js';
import { TelegramStore } from './store.js';

/** Bounded remote work. No SQL transaction spans Telegram I/O. */
export class TelegramSync {
  private readonly workerId = `telegram:${randomUUID()}`;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;
  private nextDiscovery = Date.now() + 60_000;
  private retryAt = 0;
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
      this.active = this.tick().catch((error: unknown) => {
        const wait = tl.RpcError.is(error) && 'seconds' in error ? Number(error.seconds) * 1000 : 10_000;
        this.retryAt = Date.now() + Math.max(1_000, Number.isFinite(wait) ? wait : 10_000);
        this.component = { state: 'degraded', code: 'telegram_sync_retry', detail: `Synchronization retained for retry after ${new Date(this.retryAt).toISOString()}`, checkedAt: new Date().toISOString() };
      }).finally(() => { this.active = null; if (!this.stopped) { this.timer = setTimeout(() => { this.timer = null; schedule(); }, 1_000); this.timer.unref(); } });
    };
    schedule();
  }
  /** One history page, one replay page and one control batch per turn. */
  async tick(): Promise<void> {
    if (this.stopped || Date.now() < this.retryAt || (await this.telegram.loginState()).state !== 'ready') return;
    await this.control.tick();
    if (Date.now() >= this.nextDiscovery) {
      this.nextDiscovery = Date.now() + 60_000;
      for await (const dialog of this.telegram.discoverDialogs()) { if (this.stopped) return; await this.store.upsertDialog(dialog); }
    }
    await this.controlReplay();
    const history = (await this.db.query(`SELECT c.id,c.policy_version,r.batch_size FROM chats c JOIN history_cursors h ON h.chat_id=c.id JOIN telegram_history_requests r ON r.chat_id=c.id
      WHERE c.inclusion='included' AND NOT c.is_control AND r.remaining_batches>0 AND h.status IN ('pending','running','error') AND (h.lease_until IS NULL OR h.lease_until<now()) ORDER BY h.updated_at,c.id LIMIT 1`)).rows[0];
    if (history) {
      const chatId = String(history['id']), cursor = await this.store.claimHistory(chatId, this.workerId, 30_000);
      if (cursor) {
        try { await this.store.commitHistoryBatch(chatId, Number(history['policy_version']), cursor.generation, await this.telegram.getHistory(chatId, cursor, Number(history['batch_size']))); }
        catch (error) {
          await this.db.query("UPDATE history_cursors SET status='error',last_error='History request failed; cursor retained for retry',updated_at=now() WHERE chat_id=$1 AND generation=$2", [chatId, cursor.generation]);
          if (!(error instanceof DomainError && error.code === 'conflict')) throw error;
        }
      }
    }
    const replay = (await this.db.query(`SELECT c.id,c.policy_version,l.replay_required FROM chats c JOIN live_checkpoints l ON l.chat_id=c.id
      WHERE c.inclusion='included' AND NOT c.is_control AND (l.replay_required OR l.reconciled_at IS NULL OR l.reconciled_at<now()-interval '60 seconds') ORDER BY l.reconciled_at NULLS FIRST,c.id LIMIT 1`)).rows[0];
    if (replay) {
      const chatId = String(replay['id']), checkpoint = await this.store.getLiveCheckpoint(chatId);
      // New coverage begins at a bounded current-head window. Older history is
      // exclusively governed by the persisted configurable backfill budget.
      const messages = checkpoint.highWaterMessageId === null
        ? (await this.telegram.getHistory(chatId, { ...(await this.store.getCursor(chatId)), nextMessageId: null, nextDate: null }, this.batchSize)).messages
        : await this.telegram.replayPage(chatId, checkpoint.highWaterMessageId, this.batchSize);
      try {
        await this.store.commitReplay({ chatId, expectedPolicyVersion: Number(replay['policy_version']), expectedGeneration: checkpoint.generation, messages, highWaterMessageId: Math.max(checkpoint.highWaterMessageId ?? 0, ...messages.map((m) => m.id)) || null });
        await this.reconcileRecent(chatId);
      } catch (error) { if (!(error instanceof DomainError && error.code === 'conflict')) throw error; }
    }
    this.component = { state: 'ready', code: null, detail: 'Bounded history/replay and durable control delivery workers running; inspect pending counts for coverage', checkedAt: new Date().toISOString() };
  }
  private async reconcileRecent(chatId: string): Promise<void> {
    const ids = (await this.db.query('SELECT id FROM messages WHERE chat_id=$1 AND deleted_at IS NULL ORDER BY id DESC LIMIT $2', [chatId, this.batchSize])).rows.map((r) => Number(r['id']));
    if (!ids.length) return;
    const remote = await this.telegram.recent(chatId, ids);
    // getMessages preserves positions (null = messageEmpty). It does not turn
    // whole-RPC permission/connection failures into deletion evidence.
    if (remote.length !== ids.length) throw new Error('Unexpected Telegram reconciliation cardinality');
    for (let i = 0; i < ids.length; i++) {
      const message = remote[i];
      await this.store.ingest(message ? { type: 'edit', message } : { type: 'delete', chatId, messageIds: [ids[i]!], observedAt: new Date().toISOString() });
    }
  }
  private async controlReplay(): Promise<void> {
    const chat = (await this.db.query('SELECT id FROM chats WHERE is_control')).rows[0];
    if (!chat) return;
    const chatId = String(chat['id']), key = `telegram:control-replay:${chatId}`;
    const saved = (await this.db.query('SELECT value FROM app_settings WHERE key=$1', [key])).rows[0]?.['value'];
    const prior = typeof saved === 'number' ? saved : null;
    const messages = prior === null
      ? (await this.telegram.getHistory(chatId, { chatId, nextMessageId: null, nextDate: null, status: 'pending', importedCount: 0, lastError: null, updatedAt: new Date().toISOString(), generation: 0, leaseUntil: null }, this.batchSize)).messages
      : await this.telegram.replayPage(chatId, prior, this.batchSize);
    // Each inbox row is durable before moving the independent operational cursor.
    for (const message of messages) await this.store.ingest({ type: 'message', message });
    const max = Math.max(prior ?? 0, ...messages.map((m) => m.id));
    if (max) await this.db.query('INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=to_jsonb(GREATEST((app_settings.value)::text::bigint,$3::bigint)),updated_at=now()', [key, JSON.stringify(max), max]);
  }
  async stop(): Promise<void> { this.stopped = true; if (this.timer) clearTimeout(this.timer); await this.active; this.unsubscribe?.(); this.unsubscribe = null; }
}
