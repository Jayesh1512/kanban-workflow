import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { DomainError } from '../shared/api.js';
import type { Chat, CompanyCandidate, HistoryCursor, LiveCheckpoint, PageInput } from '../shared/domain.js';
import type { ChatService, HistoryBatch, IngestionStore, RuntimeConfig, SqlExecutor, TelegramDialog, TelegramEvent, TelegramMessageInput } from '../shared/ports.js';
import { chatIdSchema, correctMappingSchema, setInclusionSchema } from '../shared/schemas.js';
import type { PgDatabase } from '../platform/database.js';

type Row = QueryResultRow;
const iso = (v: unknown): string | null => v == null ? null : new Date(v as string | Date).toISOString();
const integer = (v: unknown): number => { const n = Number(v); if (!Number.isSafeInteger(n)) throw new Error('Unsafe integer'); return n; };
export const toChat = (r: Row): Chat => ({ id: String(r['id']), kind: r['kind'] as Chat['kind'], title: String(r['title']), username: r['username'] as string | null, archived: Boolean(r['archived']), inclusion: r['inclusion'] as Chat['inclusion'], isControl: Boolean(r['is_control']), policyVersion: integer(r['policy_version']), mappingStatus: r['mapping_status'] as Chat['mappingStatus'], companyId: r['company_id'] as string | null, mappingVersion: integer(r['mapping_version']) });
export const toCursor = (r: Row): HistoryCursor => ({ chatId: String(r['chat_id']), nextMessageId: r['next_message_id'] as number | null, nextDate: iso(r['next_date']), status: r['status'] as HistoryCursor['status'], importedCount: integer(r['imported_count']), lastError: r['last_error'] as string | null, updatedAt: iso(r['updated_at'])!, generation: integer(r['generation']), leaseUntil: iso(r['lease_until']) });
const toLive = (r: Row): LiveCheckpoint => ({ chatId: String(r['chat_id']), highWaterMessageId: r['high_water_message_id'] as number | null, reconciledAt: iso(r['reconciled_at']), replayRequired: Boolean(r['replay_required']), generation: integer(r['generation']) });
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'observedAt').sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export const digest = (v: unknown): string => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const canonicalForward = (value: TelegramMessageInput['forward']) => ({ ...value, originDate: iso(value.originDate) });
const allowed = (chat: Chat) => chat.inclusion === 'included' && !chat.isControl;

export class TelegramStore implements IngestionStore, ChatService {
  constructor(readonly db: PgDatabase, private readonly config: RuntimeConfig['telegram']) {}
  private async account(tx: SqlExecutor): Promise<void> {
    if (!(await tx.query('SELECT 1 FROM telegram_account')).rowCount) throw new DomainError('not_configured', 'Bind the authorized Telegram account before ingestion');
  }
  async bindAccount(selfId: string): Promise<void> {
    if (!/^[1-9]\d*$/.test(selfId)) throw new DomainError('validation', 'Invalid Telegram account ID');
    await this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('antseed:telegram-account',0))");
      const row = (await tx.query('SELECT self_user_id FROM telegram_account WHERE singleton')).rows[0];
      if (row && String(row['self_user_id']) !== selfId) throw new DomainError('conflict', 'Telegram session belongs to a different dataset account; use a separate database/session volume');
      await tx.query('INSERT INTO telegram_account(singleton,self_user_id) VALUES(true,$1) ON CONFLICT DO NOTHING', [selfId]);
    });
  }
  async upsertDialog(dialog: TelegramDialog): Promise<Chat> {
    chatIdSchema.parse(dialog.id);
    return this.db.transaction(async (tx) => {
      await this.account(tx);
      const row = (await tx.query(`INSERT INTO chats(id,kind,title,username,archived,inclusion) VALUES($1,$2,$3,$4,$5,'included')
        ON CONFLICT(id) DO UPDATE SET kind=$2,title=$3,username=$4,archived=$5,updated_at=now() RETURNING *`, [dialog.id, dialog.kind, dialog.title, dialog.username, dialog.archived])).rows[0]!;
      await this.initCursor(tx, dialog.id);
      return toChat(row);
    });
  }
  private async initCursor(tx: SqlExecutor, chatId: string): Promise<void> {
    await tx.query('INSERT INTO history_cursors(chat_id) VALUES($1) ON CONFLICT DO NOTHING', [chatId]);
    await tx.query('INSERT INTO live_checkpoints(chat_id) VALUES($1) ON CONFLICT DO NOTHING', [chatId]);
    await tx.query('INSERT INTO telegram_history_requests(chat_id,batch_size,remaining_batches) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [chatId, this.config.historyBatchSize, this.config.historyMaxBatches]);
  }
  async lockedChat(tx: SqlExecutor, chatId: string): Promise<Chat> {
    const row = (await tx.query('SELECT * FROM chats WHERE id=$1 FOR UPDATE', [chatId])).rows[0];
    if (!row) throw new DomainError('not_found', 'Telegram chat is not discovered');
    return toChat(row);
  }
  private async command<T>(scope: string, key: string, input: unknown, work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${scope}:${key}`]);
      const hash = digest(input), existing = (await tx.query('SELECT request_hash,response FROM idempotency_keys WHERE scope=$1 AND key=$2', [scope, key])).rows[0];
      if (existing) { if (existing['request_hash'] !== hash) throw new DomainError('conflict', 'Idempotency key was used for a different request'); return existing['response'] as T; }
      const result = await work(tx);
      await tx.query('INSERT INTO idempotency_keys(scope,key,request_hash,response) VALUES($1,$2,$3,$4)', [scope, key, hash, JSON.stringify(result)]);
      return result;
    });
  }
  /** Preserve uncertain remote mutations for reconciliation; never silently move them back. */
  async invalidateChat(tx: SqlExecutor, chatId: string, reason: string): Promise<void> {
    await tx.query("UPDATE analysis_jobs SET status='cancelled',worker_id=NULL,lease_until=NULL,last_error=$2,updated_at=now() WHERE chat_id=$1 AND status NOT IN ('completed','cancelled')", [chatId, reason]);
    await tx.query(`UPDATE proposals p SET apply_state=CASE WHEN p.apply_state IN ('applying','reconciling') THEN 'reconciling' ELSE 'stale' END,last_error=$2,updated_at=now()
      FROM tickets t WHERE p.ticket_id=t.id AND t.chat_id=$1 AND p.apply_state <> 'applied'`, [chatId, reason]);
  }
  async list(input: PageInput): Promise<{ items: Chat[]; nextCursor: string | null }> {
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new DomainError('validation', 'Chat page limit must be 1..200');
    const cursor = input.cursor ? chatIdSchema.parse(input.cursor) : null;
    const rows = (await this.db.query('SELECT * FROM chats WHERE ($1::bigint IS NULL OR id>$1) ORDER BY id LIMIT $2', [cursor, limit + 1])).rows;
    return { items: rows.slice(0, limit).map(toChat), nextCursor: rows.length > limit ? String(rows[limit - 1]!['id']) : null };
  }
  async setInclusion(raw: Parameters<ChatService['setInclusion']>[0]): Promise<Chat> {
    const input = setInclusionSchema.parse(raw);
    return this.command('chat-inclusion', input.idempotencyKey, input, async (tx) => {
      const chat = await this.lockedChat(tx, input.chatId);
      if (chat.policyVersion !== input.expectedPolicyVersion) throw new DomainError('conflict', 'Chat policy changed');
      if (chat.isControl && input.inclusion === 'included') throw new DomainError('conflict', 'Control chat is operational only');
      if (chat.inclusion === input.inclusion) return chat;
      const row = (await tx.query('UPDATE chats SET inclusion=$2,policy_version=policy_version+1,updated_at=now() WHERE id=$1 RETURNING *', [chat.id, input.inclusion])).rows[0]!;
      await this.invalidateChat(tx, chat.id, 'chat_policy_changed');
      await tx.query('UPDATE live_checkpoints SET replay_required=true,generation=generation+1 WHERE chat_id=$1', [chat.id]);
      await tx.query("UPDATE history_cursors SET status=$2,generation=generation+1,worker_id=NULL,lease_until=NULL,updated_at=now() WHERE chat_id=$1", [chat.id, input.inclusion === 'excluded' ? 'paused' : 'pending']);
      await tx.query('UPDATE telegram_history_requests SET remaining_batches=$2 WHERE chat_id=$1', [chat.id, input.inclusion === 'excluded' ? 0 : this.config.historyMaxBatches]);
      await tx.query('UPDATE tickets SET tracking_state=$2,updated_at=now() WHERE chat_id=$1', [chat.id, input.inclusion === 'included' && chat.mappingStatus === 'confirmed' ? 'active' : 'suspended']);
      if (input.inclusion === 'included') await this.enqueue(tx, toChat(row));
      return toChat(row);
    });
  }
  async correctMapping(raw: Parameters<ChatService['correctMapping']>[0]): Promise<Chat> {
    const input = correctMappingSchema.parse(raw);
    return this.command('chat-mapping', input.idempotencyKey, input, async (tx) => {
      const chat = await this.lockedChat(tx, input.chatId);
      if (chat.mappingVersion !== input.expectedMappingVersion) throw new DomainError('conflict', 'Chat mapping changed');
      if (chat.isControl) throw new DomainError('conflict', 'Control chat cannot be mapped as business evidence');
      if (input.companyId && !(await tx.query('SELECT 1 FROM companies WHERE id=$1', [input.companyId])).rowCount) throw new DomainError('not_found', 'Company does not exist');
      if (input.evidenceIds.length) {
        const valid = await tx.query(`SELECT e.id FROM evidence e JOIN messages m ON (m.chat_id,m.id)=(e.chat_id,e.message_id)
          WHERE e.id=ANY($1::uuid[]) AND e.chat_id=$2 AND e.invalidated_at IS NULL AND m.deleted_at IS NULL AND m.version=e.message_version`, [input.evidenceIds, chat.id]);
        if (valid.rowCount !== new Set(input.evidenceIds).size) throw new DomainError('conflict', 'Mapping evidence is stale or outside this chat');
      }
      const row = (await tx.query('UPDATE chats SET company_id=$2,mapping_status=$3,mapping_version=mapping_version+1,updated_at=now() WHERE id=$1 RETURNING *', [chat.id, input.companyId, input.status])).rows[0]!;
      const history = (await tx.query('INSERT INTO mapping_history(chat_id,company_id,mapping_status,version,reason,source) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', [chat.id, input.companyId, input.status, row['mapping_version'], input.reason, input.source])).rows[0]!;
      for (const evidenceId of new Set(input.evidenceIds)) await tx.query('INSERT INTO mapping_history_evidence(history_id,evidence_id) VALUES($1,$2)', [history['id'], evidenceId]);
      await this.invalidateChat(tx, chat.id, 'chat_mapping_changed');
      await tx.query("UPDATE tickets SET company_id=COALESCE($2::uuid,company_id),tracking_state=$3,updated_at=now() WHERE chat_id=$1", [chat.id, input.companyId, input.status === 'confirmed' && chat.inclusion === 'included' ? 'active' : 'suspended']);
      if (allowed(toChat(row))) await this.enqueue(tx, toChat(row));
      return toChat(row);
    });
  }
  async mappingCandidates(chatId: string): Promise<CompanyCandidate[]> {
    const rows = (await this.db.query(`SELECT c.*,COALESCE(array_agg(e.evidence_id) FILTER(WHERE e.evidence_id IS NOT NULL),'{}') AS evidence_ids
      FROM mapping_candidates c LEFT JOIN mapping_candidate_evidence e ON e.candidate_id=c.id WHERE c.chat_id=$1 AND c.mapping_version=(SELECT mapping_version FROM chats WHERE id=$1) GROUP BY c.id ORDER BY confidence DESC,c.id`, [chatId])).rows;
    return rows.map((r) => ({ companyId: r['company_id'] as string | null, canonicalName: String(r['canonical_name']), confidence: Number(r['confidence']), evidenceIds: r['evidence_ids'] as string[] }));
  }
  async getCursor(chatId: string): Promise<HistoryCursor> {
    const row = (await this.db.query('SELECT * FROM history_cursors WHERE chat_id=$1', [chatId])).rows[0];
    if (!row) throw new DomainError('not_found', 'No history cursor for chat'); return toCursor(row);
  }
  async importStatus(chatId: string): Promise<HistoryCursor> { return this.getCursor(chatId); }
  async requestImport(input: Parameters<ChatService['requestImport']>[0]): Promise<HistoryCursor> {
    if (!input.idempotencyKey || !Number.isInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 100 || !Number.isInteger(input.maxBatches) || input.maxBatches < 1 || input.maxBatches > 10_000) throw new DomainError('validation', 'Invalid bounded history request');
    return this.command('chat-import', input.idempotencyKey, input, async (tx) => {
      const chat = await this.lockedChat(tx, input.chatId);
      if (!allowed(chat)) throw new DomainError('excluded_chat', 'Chat is excluded from business import');
      await this.initCursor(tx, chat.id);
      await tx.query('UPDATE telegram_history_requests SET batch_size=$2,remaining_batches=$3,updated_at=now() WHERE chat_id=$1', [chat.id, input.batchSize, input.maxBatches]);
      return toCursor((await tx.query("UPDATE history_cursors SET status='pending',generation=generation+1,worker_id=NULL,lease_until=NULL,updated_at=now() WHERE chat_id=$1 RETURNING *", [chat.id])).rows[0]!);
    });
  }
  async claimHistory(chatId: string, workerId: string, leaseMs: number): Promise<HistoryCursor | null> {
    return this.db.transaction(async (tx) => {
      const chat = await this.lockedChat(tx, chatId);
      if (!allowed(chat)) return null;
      const row = (await tx.query(`UPDATE history_cursors h SET status='running',generation=generation+1,worker_id=$2,lease_until=now()+$3*interval '1 millisecond',updated_at=now()
        FROM telegram_history_requests r WHERE h.chat_id=$1 AND r.chat_id=h.chat_id AND r.remaining_batches>0 AND h.status IN ('pending','running','error') AND (h.lease_until IS NULL OR h.lease_until<now()) RETURNING h.*`, [chatId, workerId, leaseMs])).rows[0];
      return row ? toCursor(row) : null;
    });
  }
  private async invalidateMessage(tx: SqlExecutor, chatId: string, messageId: number): Promise<void> {
    await tx.query('UPDATE evidence SET invalidated_at=now() WHERE chat_id=$1 AND message_id=$2 AND invalidated_at IS NULL', [chatId, messageId]);
    await tx.query(`UPDATE analysis_jobs j SET status='cancelled',worker_id=NULL,lease_until=NULL,last_error='source_message_changed',updated_at=now()
      WHERE j.status NOT IN ('completed','cancelled') AND EXISTS(SELECT 1 FROM analysis_job_messages m WHERE m.job_id=j.id AND m.chat_id=$1 AND m.message_id=$2)`, [chatId, messageId]);
    await tx.query(`UPDATE proposals p SET apply_state=CASE WHEN apply_state IN ('applying','reconciling') THEN 'reconciling' ELSE 'stale' END,last_error='source_message_changed',updated_at=now()
      WHERE p.apply_state<>'applied' AND EXISTS(SELECT 1 FROM proposal_evidence pe JOIN evidence e ON e.id=pe.evidence_id WHERE pe.proposal_id=p.id AND e.chat_id=$1 AND e.message_id=$2)`, [chatId, messageId]);
  }
  private async upsertMessage(tx: SqlExecutor, chat: Chat, message: TelegramMessageInput): Promise<{ changed: boolean; inserted: boolean }> {
    if (message.chatId !== chat.id || !Number.isInteger(message.id) || message.id <= 0 || message.id > 2_147_483_647) throw new DomainError('validation', 'Invalid Telegram message scope');
    const old = (await tx.query('SELECT * FROM messages WHERE chat_id=$1 AND id=$2 FOR UPDATE', [chat.id, message.id])).rows[0];
    if (old?.['deleted_at']) return { changed: false, inserted: false };
    const tombstone = (await tx.query(`SELECT min(observed_at) AS observed_at FROM message_tombstones WHERE message_id=$2 AND (chat_id=$1 OR (chat_id IS NULL AND $3::boolean))`, [chat.id, message.id, ['user', 'group'].includes(chat.kind)])).rows[0]?.['observed_at'];
    if (old && new Date(message.editedAt ?? message.sentAt).getTime() < new Date((old['edited_at'] ?? old['sent_at']) as Date).getTime()) return { changed: false, inserted: false };
    const incoming = { text: message.text, sentAt: iso(message.sentAt), editedAt: iso(message.editedAt), senderId: message.senderId, sender: message.sender, peer: message.peer, forward: canonicalForward(message.forward), replyToId: message.replyToId, sourceUrl: message.sourceUrl };
    const prior = old ? { text: old['text'], sentAt: iso(old['sent_at']), editedAt: iso(old['edited_at']), senderId: old['sender_id'] == null ? null : String(old['sender_id']), sender: old['sender_snapshot'], peer: old['peer_snapshot'], forward: canonicalForward(old['forward_metadata'] as TelegramMessageInput['forward']), replyToId: old['reply_to_id'], sourceUrl: old['source_url'] } : null;
    if (old && !tombstone && digest(incoming) === digest(prior)) return { changed: false, inserted: false };
    if (old) await this.invalidateMessage(tx, chat.id, message.id);
    await tx.query(`INSERT INTO messages(chat_id,id,sender_id,sent_at,edited_at,deleted_at,text,reply_to_id,source_url,sender_snapshot,peer_snapshot,forward_metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(chat_id,id) DO UPDATE SET sender_id=$3,sent_at=$4,edited_at=$5,deleted_at=$6,text=$7,reply_to_id=$8,source_url=$9,sender_snapshot=$10,peer_snapshot=$11,forward_metadata=$12,version=messages.version+1`,
    [chat.id, message.id, message.senderId, incoming.sentAt, incoming.editedAt, tombstone ?? null, tombstone ? '' : message.text, message.replyToId, message.sourceUrl, JSON.stringify(message.sender), JSON.stringify(message.peer), JSON.stringify(incoming.forward)]);
    return { changed: true, inserted: !old };
  }
  private async enqueue(tx: SqlExecutor, chat: Chat): Promise<void> {
    if (!allowed(chat)) return;
    const rows = (await tx.query("SELECT id,version FROM messages WHERE chat_id=$1 AND deleted_at IS NULL AND length(text)>0 ORDER BY sent_at DESC,id DESC LIMIT 100", [chat.id])).rows;
    if (!rows.length) return;
    const key = digest({ chatId: chat.id, policy: chat.policyVersion, mapping: chat.mappingVersion, messages: rows });
    const job = (await tx.query('INSERT INTO analysis_jobs(chat_id,policy_version,mapping_version,dedupe_key) VALUES($1,$2,$3,$4) ON CONFLICT(dedupe_key) DO NOTHING RETURNING id', [chat.id, chat.policyVersion, chat.mappingVersion, key])).rows[0];
    if (!job) return;
    for (const row of rows) await tx.query('INSERT INTO analysis_job_messages(job_id,chat_id,message_id,message_version) VALUES($1,$2,$3,$4)', [job['id'], chat.id, row['id'], row['version']]);
  }
  async ingest(event: TelegramEvent): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.account(tx);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('antseed:telegram-ingestion',0))");
      if (event.type === 'connection') return;
      if (event.type === 'replay_required') {
        await tx.query("UPDATE live_checkpoints SET replay_required=true,generation=generation+1 WHERE ($1::bigint IS NULL OR chat_id=$1) AND chat_id IN (SELECT id FROM chats WHERE inclusion='included' AND NOT is_control)", [event.chatId]); return;
      }
      if (event.type === 'delete') {
        // Serialize with history/live ingestion, then lock chats before messages,
        // matching the workflow's chat-first version fencing. Unknown scopes remain tombstones.
        await tx.query("SELECT id FROM chats WHERE id=$1 OR ($1::bigint IS NULL AND kind IN ('user','group')) ORDER BY id FOR UPDATE", [event.chatId]);
        for (const messageId of new Set(event.messageIds)) {
          await tx.query('INSERT INTO message_tombstones(chat_id,message_id,observed_at) VALUES($1,$2,$3) ON CONFLICT(chat_id,message_id) DO UPDATE SET observed_at=LEAST(message_tombstones.observed_at,$3)', [event.chatId, messageId, event.observedAt]);
          const affected = (await tx.query(`SELECT m.chat_id FROM messages m JOIN chats c ON c.id=m.chat_id WHERE m.id=$2 AND ($1::bigint=m.chat_id OR ($1::bigint IS NULL AND c.kind IN ('user','group'))) FOR UPDATE OF m`, [event.chatId, messageId])).rows;
          for (const row of affected) {
            const chatId = String(row['chat_id']);
            await this.invalidateMessage(tx, chatId, messageId);
            await tx.query('UPDATE messages SET deleted_at=COALESCE(deleted_at,$3),version=CASE WHEN deleted_at IS NULL THEN version+1 ELSE version END WHERE chat_id=$1 AND id=$2', [chatId, messageId, event.observedAt]);
          }
        }
        return;
      }
      const chat = await this.lockedChat(tx, event.message.chatId);
      // Operational routing precedes the mandatory business exclusion.
      if (chat.isControl) {
        const m = event.message;
        await tx.query('INSERT INTO control_inbox(chat_id,message_id,sender_id,reply_to_id,text,sent_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [chat.id, m.id, m.senderId, m.replyToId, m.text, m.sentAt]); return;
      }
      if (!allowed(chat)) return;
      if ((await this.upsertMessage(tx, chat, event.message)).changed) await this.enqueue(tx, chat);
    });
  }
  async commitHistoryBatch(chatId: string, expectedPolicyVersion: number, expectedGeneration: number, batch: HistoryBatch): Promise<HistoryCursor> {
    return this.db.transaction(async (tx) => {
      await this.account(tx); await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('antseed:telegram-ingestion',0))"); const chat = await this.lockedChat(tx, chatId);
      if (!allowed(chat) || chat.policyVersion !== expectedPolicyVersion) throw new DomainError('conflict', 'History policy changed');
      const cursor = (await tx.query('SELECT * FROM history_cursors WHERE chat_id=$1 AND generation=$2 AND lease_until>now() FOR UPDATE', [chatId, expectedGeneration])).rows[0];
      if (!cursor) throw new DomainError('conflict', 'History lease/cursor was superseded');
      let inserted = 0, changed = false;
      for (const message of batch.messages) { const result = await this.upsertMessage(tx, chat, message); inserted += Number(result.inserted); changed ||= result.changed; }
      if (changed) await this.enqueue(tx, chat);
      const request = (await tx.query('UPDATE telegram_history_requests SET remaining_batches=GREATEST(remaining_batches-1,0),updated_at=now() WHERE chat_id=$1 RETURNING remaining_batches', [chatId])).rows[0]!;
      const status = batch.complete ? 'complete' : integer(request['remaining_batches']) > 0 ? 'pending' : 'paused';
      return toCursor((await tx.query('UPDATE history_cursors SET next_message_id=$2,next_date=$3,status=$4,imported_count=imported_count+$5,generation=generation+1,worker_id=NULL,lease_until=NULL,last_error=NULL,updated_at=now() WHERE chat_id=$1 RETURNING *', [chatId, batch.next?.messageId ?? null, batch.next?.date ?? null, status, inserted])).rows[0]!);
    });
  }
  async getLiveCheckpoint(chatId: string): Promise<LiveCheckpoint> {
    const row = (await this.db.query('SELECT * FROM live_checkpoints WHERE chat_id=$1', [chatId])).rows[0];
    if (!row) throw new DomainError('not_found', 'No live checkpoint for chat'); return toLive(row);
  }
  async commitReplay(input: Parameters<IngestionStore['commitReplay']>[0]): Promise<LiveCheckpoint> {
    return this.db.transaction(async (tx) => {
      await this.account(tx); await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('antseed:telegram-ingestion',0))"); const chat = await this.lockedChat(tx, input.chatId);
      if (!allowed(chat) || chat.policyVersion !== input.expectedPolicyVersion) throw new DomainError('conflict', 'Replay policy changed');
      const row = (await tx.query('SELECT * FROM live_checkpoints WHERE chat_id=$1 AND generation=$2 FOR UPDATE', [chat.id, input.expectedGeneration])).rows[0];
      if (!row) throw new DomainError('conflict', 'Replay generation was superseded');
      const prior = (row['high_water_message_id'] as number | null) ?? 0;
      const max = Math.max(prior, ...input.messages.map((m) => m.id));
      if ((input.highWaterMessageId ?? 0) !== max) throw new DomainError('validation', 'Replay high-water must match its scanned message coverage');
      let changed = false;
      for (const message of input.messages) changed = (await this.upsertMessage(tx, chat, message)).changed || changed;
      if (changed) await this.enqueue(tx, chat);
      // A nonempty page always needs a following probe; short pages may contain
      // filtered Telegram messageEmpty entries and do not prove history ended.
      return toLive((await tx.query('UPDATE live_checkpoints SET high_water_message_id=$2,reconciled_at=now(),replay_required=$3,generation=generation+1 WHERE chat_id=$1 RETURNING *', [chat.id, max || null, input.messages.length > 0])).rows[0]!);
    });
  }
}
