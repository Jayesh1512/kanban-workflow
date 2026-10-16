import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BaseTelegramClient, Long, TelegramClient, User, tl } from '@mtcute/node';
import { LogManager } from '@mtcute/node/utils.js';
import type { Message as MtcuteMessage } from '@mtcute/node';
import { DomainError } from '../shared/api.js';
import type { ServiceStatus } from '../shared/domain.js';
import type { ControlSetup, HistoryBatch, RuntimeConfig, TelegramDialog, TelegramEvent, TelegramLoginInput, TelegramLoginState, TelegramMessageInput, TelegramPort } from '../shared/ports.js';
import { normalizeDialog, normalizeMessage, peerNumber, decimalId } from './normalize.js';
import { AwaitedQueue } from './queue.js';
import type { TelegramStore } from './store.js';

export type ClientFactory = (mode: 'auth' | 'live', onTooLong: (chatId: number) => void) => TelegramClient;
const status = (state: ServiceStatus['state'], code: string | null, detail: string | null): ServiceStatus => ({ state, code, detail, checkedAt: new Date().toISOString() });
export class MtcuteAdapter implements TelegramPort {
  private auth: TelegramClient | null = null;
  private live: TelegramClient | null = null;
  private selfId: string | null = null;
  private pending: { phone: string; hash: string; delivery: string; resendAt: string } | null = null;
  private login: TelegramLoginState;
  private component: ServiceStatus;
  private readonly listeners = new Set<(event: TelegramEvent) => Promise<void>>();
  private readonly stopController = new AbortController();
  private readonly queue: AwaitedQueue<TelegramEvent>;
  private busy = false;
  private passwordNeeded = false;
  private stopped = false;
  private started = false;
  private readonly factory: ClientFactory;
  private setup: { configure(input: Parameters<TelegramPort['configureControlChat']>[0]): Promise<ControlSetup>; reconcile(key: string): Promise<ControlSetup> } | null = null;
  constructor(private readonly config: RuntimeConfig['telegram'], private readonly store: TelegramStore, factory?: ClientFactory) {
    const configured = Boolean(config.apiId && config.apiHash);
    this.login = { state: configured ? 'disconnected' : 'unconfigured', detail: configured ? 'Enter your phone number to connect Telegram' : 'Configure TELEGRAM_API_ID and TELEGRAM_API_HASH' };
    this.component = status(configured ? 'degraded' : 'unconfigured', 'login_required', this.login.detail);
    this.queue = new AwaitedQueue(async (event) => { for (const handler of this.listeners) await handler(event); }, async () => {
      this.component = status('degraded', 'ingestion_replay_required', 'Persistence is delayed; missed updates require replay');
      for (const handler of this.listeners) await handler({ type: 'replay_required', chatId: null, reason: 'queue_failure' });
    });
    this.factory = factory ?? ((mode, onTooLong) => {
      if (!config.apiId || !config.apiHash) throw new DomainError('not_configured', 'Configure Telegram API credentials');
      const base = new BaseTelegramClient({ apiId: config.apiId, apiHash: config.apiHash, storage: config.sessionPath, logLevel: LogManager.OFF,
        updates: mode === 'auth' ? false : { catchUp: true, onChannelTooLong: (channelId) => onTooLong(channelId) } });
      // All high-level methods funnel through this public RPC seam. Bound calls
      // and surface flood waits to the worker instead of sleeping invisibly.
      const call = base.call.bind(base);
      base.call = (request, options = {}) => {
        const sessionSignal = this.store.db.sessionSignal;
        return call(request, { timeout: 15_000, maxRetryCount: 1, floodSleepThreshold: 0, ...options, abortSignal: AbortSignal.any([this.stopController.signal, ...(sessionSignal ? [sessionSignal] : []), ...(options.abortSignal ? [options.abortSignal] : [])]) });
      };
      return new TelegramClient({ client: base });
    });
  }
  setControlSetup(setup: NonNullable<MtcuteAdapter['setup']>): void { this.setup = setup; }
  requireLive(): TelegramClient { if (!this.live || !this.selfId || this.login.state !== 'ready') throw new DomainError('not_configured', 'Connect the Telegram account before this action'); return this.live; }
  async authorizedSelf(): Promise<string | null> { return this.selfId; }
  async loginState(): Promise<TelegramLoginState> { return this.login; }
  async status(): Promise<ServiceStatus> {
    if (this.queue.size || this.queue.requiresReplay) return status('degraded', 'ingestion_pending', 'Telegram updates are waiting for durable ingestion/replay');
    return this.component;
  }
  subscribe(handler: (event: TelegramEvent) => Promise<void>): () => void { this.listeners.add(handler); return () => { this.listeners.delete(handler); }; }
  private make(mode: 'auth' | 'live'): TelegramClient {
    return this.factory(mode, (chatId) => this.queue.push({ type: 'replay_required', chatId: decimalId(chatId), reason: 'too_long' }));
  }
  private failure(error: unknown): void {
    const rpc = tl.RpcError.is(error) ? error.text : '';
    const code = /^[A-Z][A-Z0-9_]{0,80}$/.test(rpc) ? rpc : error instanceof DomainError && error.code === 'conflict' ? 'dataset_account_mismatch' : 'telegram_unavailable';
    const wait = /^FLOOD_WAIT_(\d+)$/.exec(code);
    const retryAt = wait ? new Date(Date.now() + Number(wait[1]) * 1000).toISOString() : null;
    const detail = code === 'dataset_account_mismatch' ? 'This Telegram account does not match the dataset; use separate database/session volumes' : wait ? 'Telegram rate limit reached; wait until retryAt' : 'Telegram request failed; check the connection or enter a valid login code/password';
    this.login = { state: 'error', code, detail, retryAt };
    this.component = status('unavailable', code, detail);
  }
  private async activate(user: User): Promise<void> {
    // Authentication client has updates:false. No loop can advance before this bind.
    await this.store.bindAccount(decimalId(user.id));
    this.login = { state: 'connecting', detail: 'Account bound; discovering cloud dialogs before live catch-up' };
    this.component = status('connecting', 'dialog_discovery', this.login.detail);
    await this.auth?.destroy(); this.auth = null; this.pending = null; this.passwordNeeded = false;
    if (this.stopped) return;
    const live = this.make('live'); this.live = live;
    await live.prepare();
    const verified = await live.getMe();
    await this.store.bindAccount(decimalId(verified.id));
    this.selfId = decimalId(verified.id);
    live.onNewMessage.add((m) => this.onMessage(m, 'message'));
    live.onEditMessage.add((m) => this.onMessage(m, 'edit'));
    live.onDeleteMessage.add((update) => this.queue.push({ type: 'delete', chatId: update.channelId === null ? null : decimalId(update.channelId), messageIds: update.messageIds, observedAt: new Date().toISOString() }));
    live.onConnectionState.add((connection) => {
      this.component = connection === 'connected' ? status('ready', null, 'Telegram connected; application replay/import status is tracked separately') : status('degraded', `telegram_${connection}`, 'Telegram is reconnecting or catching up');
      if (connection === 'connected' || connection === 'updating') this.queue.push({ type: 'replay_required', chatId: null, reason: 'reconnect' });
    });
    live.onError.add(() => { this.component = status('degraded', 'telegram_connection_error', 'Telegram connection needs recovery'); this.queue.push({ type: 'replay_required', chatId: null, reason: 'reconnect' }); });
    // Discover only after account identity is durable, before automatic catch-up.
    for await (const d of live.iterDialogs({ archived: 'keep', chunkSize: 100 })) await this.store.upsertDialog(normalizeDialog(d.peer, d.isArchived));
    this.login = { state: 'ready', detail: null };
    await live.notifyLoggedIn(verified.raw); // mtcute automatically starts catchUp here.
    this.component = status('ready', null, 'Telegram account connected; import/replay runs in bounded jobs');
    this.queue.push({ type: 'replay_required', chatId: null, reason: 'reconnect' });
  }
  private onMessage(message: MtcuteMessage, type: 'message' | 'edit'): void {
    if (!this.selfId || this.stopped) return;
    try { this.queue.push({ type, message: normalizeMessage(message) }); }
    catch { this.queue.push({ type: 'replay_required', chatId: null, reason: 'queue_failure' }); }
  }
  async start(): Promise<void> {
    if (this.started || this.stopped) return; this.started = true;
    if (!this.config.apiId || !this.config.apiHash) return;
    await mkdir(dirname(this.config.sessionPath), { recursive: true, mode: 0o700 });
    const exists = await stat(this.config.sessionPath).then(() => true, () => false);
    if (!exists) return; // A fresh start never sends a code or opens a terminal prompt.
    this.login = { state: 'connecting', detail: 'Restoring the saved Telegram session' };
    this.auth = this.make('auth'); this.busy = true;
    try { await this.auth.prepare(); await this.activate(await this.auth.getMe()); }
    catch (error) { this.failure(error); await this.auth?.destroy(); this.auth = null; await this.live?.destroy(); this.live = null; this.selfId = null; }
    finally { this.busy = false; }
  }
  private async closeLive(): Promise<void> { await this.live?.destroy(); this.live = null; this.selfId = null; }
  async submitLogin(input: TelegramLoginInput): Promise<TelegramLoginState> {
    if (!this.config.apiId || !this.config.apiHash) throw new DomainError('not_configured', 'Configure Telegram API credentials');
    if (this.busy || this.live) throw new DomainError('conflict', this.live ? 'Telegram is already connected' : 'A login request is already in progress');
    if (this.stopped) throw new DomainError('upstream_unavailable', 'Telegram adapter is stopped');
    if (this.login.state === 'error' && this.login.retryAt && Date.parse(this.login.retryAt) > Date.now()) return this.login;
    this.busy = true;
    try {
      this.auth ??= this.make('auth'); await this.auth.prepare();
      if (input.step === 'phone') {
        if (!/^\+?[\d\s()-]{5,32}$/.test(input.phone)) throw new DomainError('validation', 'Enter an international phone number');
        const phone = input.phone.replace(/[^\d+]/g, '');
        if (this.pending?.phone === phone && Date.parse(this.pending.resendAt) > Date.now()) throw new DomainError('conflict', 'Wait until the advertised resend time');
        const result = await this.auth.sendCode({ phone, abortSignal: AbortSignal.timeout(15_000) });
        if (result instanceof User) await this.activate(result);
        else {
          const resendAt = new Date(Date.now() + result.timeout * 1000).toISOString();
          this.pending = { phone, hash: result.phoneCodeHash, delivery: result.type, resendAt };
          this.login = { state: 'code_required', phone: `***${phone.slice(-2)}`, delivery: result.type, resendAt };
          this.component = status('degraded', 'code_required', 'Enter the Telegram confirmation code');
        }
      } else if (input.step === 'code') {
        if (!this.pending) throw new DomainError('conflict', 'Request a login code first');
        try { await this.activate(await this.auth.signIn({ phone: this.pending.phone, phoneCodeHash: this.pending.hash, phoneCode: input.code, abortSignal: AbortSignal.timeout(15_000) })); }
        catch (error) {
          if (tl.RpcError.is(error, 'SESSION_PASSWORD_NEEDED')) { this.passwordNeeded = true; this.login = { state: 'password_required', hint: null }; this.component = status('degraded', 'password_required', 'Enter the Telegram two-step verification password'); }
          else throw error;
        }
      } else {
        if (!this.passwordNeeded) throw new DomainError('conflict', 'A two-step verification password was not requested');
        await this.activate(await this.auth.checkPassword({ password: input.password, abortSignal: AbortSignal.timeout(15_000) }));
      }
    } catch (error) {
      if (error instanceof DomainError && ['validation', 'conflict'].includes(error.code) && !error.message.includes('dataset')) throw error;
      this.failure(error);
      await this.closeLive();
      if (this.login.state === 'error' && this.login.code === 'dataset_account_mismatch') { await this.auth?.destroy(); this.auth = null; this.pending = null; this.passwordNeeded = false; }
    } finally { this.busy = false; }
    return this.login;
  }
  async *discoverDialogs(): AsyncIterable<TelegramDialog> {
    for await (const dialog of this.requireLive().iterDialogs({ archived: 'keep', chunkSize: 100 })) yield normalizeDialog(dialog.peer, dialog.isArchived);
  }
  async describe(chatId: string): Promise<TelegramDialog> {
    const dialog = (await this.requireLive().getPeerDialogs(peerNumber(chatId)))[0];
    if (!dialog) throw new DomainError('not_found', 'Telegram dialog is not accessible');
    return normalizeDialog(dialog.peer, dialog.isArchived);
  }
  async getHistory(chatId: string, cursor: Parameters<TelegramPort['getHistory']>[1], limit: number): Promise<HistoryBatch> {
    const page = await this.requireLive().getHistory(peerNumber(chatId), { limit, ...(cursor.nextMessageId !== null && cursor.nextDate !== null ? { offset: { id: cursor.nextMessageId, date: Math.floor(Date.parse(cursor.nextDate) / 1000) } } : {}) });
    return { messages: page.map((m) => normalizeMessage(m)), next: page.next ? { messageId: page.next.id, date: new Date(page.next.date * 1000).toISOString() } : null, complete: page.length === 0 };
  }
  async replayPage(chatId: string, afterId: number | null, limit: number): Promise<TelegramMessageInput[]> {
    const page = await this.requireLive().getHistory(peerNumber(chatId), { reverse: true, limit, offset: { id: (afterId ?? 0) + 1, date: 0 }, minId: afterId ?? 0 });
    return page.map((m) => normalizeMessage(m));
  }
  async recent(chatId: string, ids: number[]): Promise<Array<TelegramMessageInput | null>> {
    const messages = await this.requireLive().getMessages(peerNumber(chatId), ids);
    if (messages.length !== ids.length) throw new DomainError('upstream_unavailable', 'Telegram reconciliation returned incomplete positions', true);
    const byId = new Map(messages.filter((m) => m !== null).map((m) => [m.id, normalizeMessage(m)]));
    return ids.map((id) => byId.get(id) ?? null);
  }
  async configureControlChat(input: Parameters<TelegramPort['configureControlChat']>[0]): Promise<ControlSetup> { if (!this.setup) throw new DomainError('not_configured', 'Control setup is unavailable'); return this.setup.configure(input); }
  async reconcileControlSetup(key: string): Promise<ControlSetup> { if (!this.setup) throw new DomainError('not_configured', 'Control setup is unavailable'); return this.setup.reconcile(key); }
  async sendControlMessage(input: Parameters<TelegramPort['sendControlMessage']>[0]): Promise<{ messageId: number }> {
    const destination = (await this.store.db.query('SELECT 1 FROM chats WHERE id=$1 AND is_control', [input.chatId])).rowCount;
    if (!destination) throw new DomainError('conflict', 'Operational messages may only target the configured control group');
    if (!/^-?[1-9]\d*$/.test(input.randomId) || BigInt(input.randomId) < -(2n ** 63n) || BigInt(input.randomId) >= 2n ** 63n) throw new DomainError('validation', 'Invalid MTProto random ID');
    const message = await this.requireLive().sendText(peerNumber(input.chatId), input.text, { randomId: Long.fromString(input.randomId), disableWebPreview: true, ...(input.replyToMessageId ? { replyTo: input.replyToMessageId, mustReply: true } : {}), abortSignal: AbortSignal.timeout(15_000) });
    return { messageId: message.id };
  }
  async stop(): Promise<void> {
    if (this.stopped) return; this.stopped = true;
    await this.live?.stopUpdatesLoop();
    await this.queue.flush(5_000); this.stopController.abort();
    await this.auth?.destroy(); await this.live?.destroy(); await this.queue.close();
    this.auth = null; this.live = null; this.selfId = null; this.pending = null;
  }
}
