import { randomBytes } from 'node:crypto';
import type { ServiceStatus } from '../shared/domain.js';
import type { Database, TelegramMessageInput, TelegramPort } from '../shared/ports.js';
import type { ReplyAnalyzer, ReplyContextMessage, ReplyDecision } from './analyzer.js';

const LAST_RUN_KEY = 'reply:last-run';
const EMPTY_CURSOR = { chatId: '', nextMessageId: null, nextDate: null, status: 'pending' as const, importedCount: 0, lastError: null, updatedAt: new Date(0).toISOString(), generation: 0, leaseUntil: null };

export interface ReplyAgentOptions {
  intervalMs: number;
  maxChats: number;
  contextMessages: number;
  windowMinutes: number;
  ownerNames: string[];
  /** 'self' = Saved Messages, 'off' = store only, otherwise an explicit chat ID. */
  digestChatId: string;
  timezone: string;
  now?: () => Date;
}

export interface ScanSummary { chats: number; skipped: number; failed: number; suggestions: number; delivered: number }
interface Candidate { id: string; title: string; cursor: number | null; latest: string | null }
interface Created { id: string; chatTitle: string; decision: ReplyDecision }

/** Bounded hourly scan. No SQL transaction spans Telegram or provider I/O. */
export class ReplyAgent {
  private state: ServiceStatus;
  private running: Promise<ScanSummary> | null = null;
  private readonly now: () => Date;
  constructor(private readonly db: Database, private readonly telegram: TelegramPort, private readonly analyzer: ReplyAnalyzer, private readonly options: ReplyAgentOptions) {
    this.now = options.now ?? (() => new Date());
    this.state = { state: 'connecting', code: 'not_started', detail: 'Reply agent has not run yet', checkedAt: this.now().toISOString() };
  }
  status(): ServiceStatus { return { ...this.state }; }
  async lastRunAt(): Promise<string | null> {
    try {
      const row = (await this.db.query("SELECT value FROM app_settings WHERE key=$1", [LAST_RUN_KEY])).rows[0];
      const at = (row?.['value'] as { at?: unknown } | undefined)?.at;
      return typeof at === 'string' ? at : null;
    } catch { return null; }
  }
  private async markRun(at: string): Promise<void> {
    await this.db.query("INSERT INTO app_settings(key,value) VALUES($1,jsonb_build_object('at',$2::text)) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()", [LAST_RUN_KEY, at]);
  }
  /** One scan. A second concurrent call joins the running scan instead of duplicating remote work. */
  scanOnce(trigger: 'scheduled' | 'manual', signal?: AbortSignal): Promise<ScanSummary> {
    if (this.running) return this.running;
    this.running = this.run(trigger, signal).finally(() => { this.running = null; });
    return this.running;
  }
  private async run(trigger: 'scheduled' | 'manual', signal?: AbortSignal): Promise<ScanSummary> {
    const summary: ScanSummary = { chats: 0, skipped: 0, failed: 0, suggestions: 0, delivered: 0 };
    const selfId = await this.telegram.authorizedSelf();
    if (!selfId) {
      this.state = this.failed('login_required', 'Connect the Telegram account before the reply agent can read unread groups');
      return summary;
    }
    const provider = await this.analyzer.status();
    if (provider.state === 'unconfigured') {
      this.state = this.failed('provider_unconfigured', 'OpenAI is not configured; the reply agent cannot analyse messages');
      return summary;
    }
    const candidates = await this.db.query<Candidate & Record<string, unknown>>(`
      SELECT c.id::text AS id, c.title, r.last_scanned_message_id AS cursor, s.latest_message_at::text AS latest
      FROM chats c
      LEFT JOIN telegram_conversation_starts s ON s.chat_id=c.id
      LEFT JOIN reply_scans r ON r.chat_id=c.id
      WHERE c.kind IN ('group','supergroup') AND NOT c.is_control AND c.inclusion<>'excluded'
      ORDER BY COALESCE(s.latest_message_at, c.updated_at) DESC, c.id
      LIMIT $1`, [this.options.maxChats]);
    const created: Created[] = [];
    let providerFailed = false;
    for (const row of candidates.rows) {
      if (signal?.aborted) break;
      summary.chats++;
      try {
        const result = await this.scanChat({ id: String(row['id']), title: String(row['title']), cursor: row['cursor'] === null ? null : Number(row['cursor']), latest: row['latest'] }, selfId, signal);
        if (result === 'provider') providerFailed = true;
        else if (result === 'skipped') summary.skipped++;
        else if (result !== null && typeof result === 'object' && result.suggestion) { summary.suggestions++; created.push(result.suggestion); }
      } catch (error) {
        summary.failed++;
        await this.recordError(String(row['id']), error instanceof Error ? error.message.slice(0, 300) : 'scan_failed');
      }
    }
    if (created.length) summary.delivered = await this.deliver(created);
    const at = this.now().toISOString();
    if (trigger === 'scheduled' || created.length) await this.markRun(at);
    this.state = providerFailed || summary.failed
      ? { state: 'degraded', code: 'reply_scan_partial', detail: `${summary.chats} groups checked; ${summary.failed} failed${providerFailed ? '; provider unavailable for some groups' : ''}; ${summary.suggestions} suggestions; ${summary.delivered} delivered`, checkedAt: at }
      : { state: 'ready', code: null, detail: `${summary.chats} groups checked; ${summary.skipped} had no new incoming messages; ${summary.suggestions} suggestions; ${summary.delivered} delivered`, checkedAt: at };
    return summary;
  }
  private failed(code: string, detail: string): ServiceStatus { return { state: 'degraded', code, detail, checkedAt: this.now().toISOString() }; }
  private async scanChat(candidate: Candidate, selfId: string, signal?: AbortSignal): Promise<{ suggestion?: Created } | 'skipped' | 'provider' | null> {
    const now = this.now();
    const since = now.getTime() - this.options.windowMinutes * 60_000;
    const limit = Math.min(100, Math.max(60, this.options.contextMessages));
    const batch = await this.telegram.getHistory(candidate.id, { ...EMPTY_CURSOR, chatId: candidate.id }, limit);
    const messages = [...batch.messages].sort((a, b) => a.id - b.id);
    if (!messages.length) { await this.saveScan(candidate.id, candidate.cursor ?? 0, now, null); return 'skipped'; }
    const latest = Math.max(candidate.cursor ?? 0, ...messages.map((message) => message.id));
    const recent = messages.filter((message) => Date.parse(message.sentAt) >= since);
    const lastN = messages.slice(-this.options.contextMessages);
    // First run treats only the last hour as unread. Later runs treat anything
    // above the stored cursor as new, even if the agent was offline for a while.
    const fresh = (candidate.cursor === null ? recent : messages).filter((message) => message.id > (candidate.cursor ?? 0) && message.senderId !== selfId && message.text.trim().length > 0);
    const context = this.context(lastN, recent, fresh);
    const shown = new Set(context.map((message) => message.id));
    const visibleFresh = fresh.filter((message) => shown.has(message.id));
    if (!visibleFresh.length) { await this.saveScan(candidate.id, latest, now, null); return 'skipped'; }
    const decision = await this.analyzer.analyze({
      chatTitle: candidate.title, ownerNames: this.options.ownerNames,
      freshMessageIds: visibleFresh.map((message) => message.id),
      messages: context.map((message) => this.project(message, selfId)),
      now: now.toISOString(), timezone: this.options.timezone,
    }, signal);
    if (!decision.ok) {
      // Invalid model output would repeat forever, so record it and move past
      // these messages. Transport failures keep the cursor for the next run.
      const advanced = decision.code === 'invalid_response' ? latest : candidate.cursor ?? 0;
      await this.saveScan(candidate.id, advanced, now, decision.detail);
      return decision.code === 'invalid_response' ? null : 'provider';
    }
    await this.saveScan(candidate.id, latest, now, null);
    if (!decision.value.relevant) return null;
    const trigger = visibleFresh[visibleFresh.length - 1]!;
    const id = await this.persist(candidate, trigger, context, decision.value);
    if (!id) return null;
    return { suggestion: { id, chatTitle: candidate.title, decision: decision.value } };
  }
  /** Union of the last N messages, the time window and fresh messages, ascending, deduplicated. */
  private context(lastN: TelegramMessageInput[], recent: TelegramMessageInput[], fresh: TelegramMessageInput[]): TelegramMessageInput[] {
    const byId = new Map<number, TelegramMessageInput>();
    for (const message of [...lastN, ...recent, ...fresh]) byId.set(message.id, message);
    return [...byId.values()].sort((a, b) => a.id - b.id).slice(-80);
  }
  private project(message: TelegramMessageInput, selfId: string): ReplyContextMessage {
    const name = message.sender.names.find((value) => value.trim().length > 0) ?? message.sender.usernames[0] ?? (message.sender.kind === 'user' ? 'Member' : 'Channel');
    return { id: message.id, sentAt: message.sentAt, from: message.senderId === selfId ? 'owner' : 'other', senderName: message.senderId === selfId ? 'Owner' : name.slice(0, 80), text: (message.text.trim() || '[no text]').slice(0, 1000) };
  }
  private async persist(candidate: Candidate, trigger: TelegramMessageInput, context: TelegramMessageInput[], decision: ReplyDecision): Promise<string | null> {
    const ids = context.map((message) => message.id);
    const row = (await this.db.query<{ id: string }>(`INSERT INTO reply_suggestions(
        chat_id,chat_title,trigger_message_id,first_message_id,last_message_id,message_count,addressed_to,urgency,relevance_reason,suggested_text,model)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT(chat_id,trigger_message_id) DO NOTHING RETURNING id`, [
      candidate.id, candidate.title.slice(0, 500), trigger.id, Math.min(...ids), Math.max(...ids), Math.min(200, ids.length),
      decision.addressedTo.slice(0, 120), decision.urgency, decision.reason, decision.suggestedText, 'reply-agent',
    ])).rows[0];
    return row ? String(row.id) : null;
  }
  private async saveScan(chatId: string, lastMessageId: number, at: Date, error: string | null): Promise<void> {
    await this.db.query(`INSERT INTO reply_scans(chat_id,last_scanned_message_id,last_scanned_at,last_run_at,last_error,updated_at)
      VALUES($1,$2,$3,$3,$4,now())
      ON CONFLICT(chat_id) DO UPDATE SET last_scanned_message_id=GREATEST(reply_scans.last_scanned_message_id,$2),last_scanned_at=$3,last_run_at=$3,last_error=$4,updated_at=now()`,
      [chatId, lastMessageId, at.toISOString(), error]);
  }
  private async recordError(chatId: string, error: string): Promise<void> {
    try { await this.saveScan(chatId, 0, this.now(), error); } catch { /* keep the scan result */ }
  }
  /** One combined digest per run; no message is ever sent to the source group. */
  private async deliver(created: Created[]): Promise<number> {
    if (this.options.digestChatId === 'off') return 0;
    if (!this.telegram.sendText) return 0;
    const selfId = await this.telegram.authorizedSelf();
    const chatId = this.options.digestChatId === 'self' ? selfId : this.options.digestChatId;
    if (!chatId) return 0;
    const text = this.digest(created);
    const ids = created.map((item) => item.id);
    try {
      const sent = await this.telegram.sendText({ chatId, text, randomId: randomSignedId() });
      await this.db.query('UPDATE reply_suggestions SET delivered_at=now(),delivery_message_id=$2,delivery_error=NULL WHERE id=ANY($1::uuid[])', [ids, sent.messageId]);
      return created.length;
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 300) : 'delivery_failed';
      await this.db.query('UPDATE reply_suggestions SET delivery_error=$2 WHERE id=ANY($1::uuid[])', [ids, detail]);
      return 0;
    }
  }
  private digest(created: Created[]): string {
    const stamp = new Intl.DateTimeFormat('en-GB', { timeZone: this.options.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(this.now());
    const lines = [`Reply agent — ${stamp}`, ''];
    for (const [index, item] of created.entries()) {
      const block = [`${index + 1}. ${item.chatTitle}`, `Why: ${item.decision.reason}`, `For: ${item.decision.addressedTo} · ${item.decision.urgency}`, '', item.decision.suggestedText, ''].join('\n');
      if (lines.join('\n').length + block.length > 3_600) { lines.push(`(+${created.length - index} more suggestions in /api/reply/suggestions)`); break; }
      lines.push(block);
    }
    return lines.join('\n').slice(0, 4_000);
  }
}

function randomSignedId(): string {
  let value = 0n;
  while (value === 0n) value = randomBytes(8).readBigInt64BE();
  return value.toString();
}
