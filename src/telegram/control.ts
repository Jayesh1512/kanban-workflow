import { ChatIntake } from './intake.js';
import { randomBytes, randomUUID } from 'node:crypto';
import type { TelegramClient } from '@mtcute/node';
import { DomainError } from '../shared/api.js';
import type { ServiceStatus } from '../shared/domain.js';
import type { ControlBus, ControlMessage, ControlSetup, SqlExecutor, TelegramPort } from '../shared/ports.js';
import type { PgDatabase } from '../platform/database.js';
import type { TelegramStore } from './store.js';
import { digest } from './store.js';
import { normalizeDialog, peerNumber } from './normalize.js';

export class ControlSetupManager {
  constructor(private readonly db: PgDatabase, private readonly store: TelegramStore, private readonly client: () => TelegramClient) {}
  private async result(key: string): Promise<ControlSetup> {
    const row = (await this.db.query('SELECT * FROM control_setup_operations WHERE operation_key=$1', [key])).rows[0];
    if (!row) throw new DomainError('not_found', 'No control setup operation');
    const chat = row['chat_id'] ? (await this.db.query('SELECT * FROM chats WHERE id=$1', [row['chat_id']])).rows[0] : null;
    return { operationKey: key, marker: String(row['marker']), state: row['state'] as ControlSetup['state'], lastError: row['last_error'] as string | null,
      chat: chat ? { id: String(chat['id']), kind: chat['kind'] as 'group' | 'supergroup', title: String(chat['title']), username: chat['username'] as string | null, archived: Boolean(chat['archived']) } : null };
  }
  private async finish(key: string, chatId: string): Promise<ControlSetup> {
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM chats WHERE is_control OR id=$1 ORDER BY id FOR UPDATE', [chatId]);
      await tx.query('UPDATE chats SET is_control=false,policy_version=policy_version+1,updated_at=now() WHERE is_control AND id<>$1', [chatId]);
      await tx.query("UPDATE chats SET is_control=true,inclusion='excluded',policy_version=policy_version+1,updated_at=now() WHERE id=$1", [chatId]);
      await this.store.invalidateChat(tx, chatId, 'control_chat_configured');
      await tx.query("UPDATE chat_intake_requests SET decision='cancelled',decided_at=now() WHERE chat_id=$1 AND decision='pending'", [chatId]);
      await tx.query("UPDATE history_cursors SET status='paused',generation=generation+1,lease_until=NULL,worker_id=NULL WHERE chat_id=$1", [chatId]);
      await tx.query('UPDATE telegram_history_requests SET remaining_batches=0 WHERE chat_id=$1', [chatId]);
      await tx.query('UPDATE live_checkpoints SET replay_required=false,generation=generation+1 WHERE chat_id=$1', [chatId]);
      await tx.query("UPDATE tickets SET tracking_state='suspended' WHERE chat_id=$1", [chatId]);
      await tx.query("UPDATE control_setup_operations SET state='configured',chat_id=$2,last_error=NULL,updated_at=now() WHERE operation_key=$1", [key, chatId]);
    });
    return this.result(key);
  }
  async configure(input: Parameters<TelegramPort['configureControlChat']>[0]): Promise<ControlSetup> {
    const client = this.client();
    return this.db.withSessionLock('antseed:control-setup', async () => {
      const previous = (await this.db.query('SELECT request_hash,state FROM control_setup_operations WHERE operation_key=$1', [input.operationKey])).rows[0];
      if (previous) {
        if (previous['request_hash'] !== digest(input)) throw new DomainError('conflict', 'Setup operation key was used for a different request');
        if (previous['state'] === 'remote_unknown') return this.reconcileUnlocked(input.operationKey);
        if (previous['state'] !== 'prepared') return this.result(input.operationKey);
      } else {
        await this.db.query('INSERT INTO control_setup_operations(operation_key,request_hash,marker,request) VALUES($1,$2,$3,$4)', [input.operationKey, digest(input), `[antseed-control:${randomUUID()}]`, JSON.stringify(input)]);
      }
      const setup = await this.result(input.operationKey);
      if ('createPrivateSupergroup' in input && (await this.db.query("SELECT 1 FROM control_setup_operations WHERE state='remote_unknown' AND operation_key<>$1", [input.operationKey])).rowCount) throw new DomainError('conflict', 'Reconcile the existing unknown group creation before another create request');
      if ('chatId' in input) {
        const chat = await client.getChat(peerNumber(input.chatId));
        if (!['group', 'supergroup'].includes(chat.chatType)) throw new DomainError('validation', 'Control chat must be an existing group or supergroup');
        const dialog = (await client.getPeerDialogs(chat.id))[0];
        await this.store.upsertDialog(normalizeDialog(chat, dialog?.isArchived ?? false));
        return this.finish(input.operationKey, input.chatId);
      }
      // Persist uncertainty BEFORE the non-idempotent remote creation. Once this
      // state exists, only read/reconcile; never blindly create a second group.
      await this.db.query("UPDATE control_setup_operations SET state='remote_unknown',updated_at=now() WHERE operation_key=$1", [input.operationKey]);
      try {
        const chat = await client.createSupergroup({ title: input.title, description: `AntSeed operational approvals ${setup.marker}`, forum: false });
        const dialog = normalizeDialog(chat, false);
        await this.store.upsertDialog(dialog);
        return await this.finish(input.operationKey, dialog.id);
      } catch {
        await this.db.query("UPDATE control_setup_operations SET last_error='Creation outcome is unknown; use reconcile, not another create request',updated_at=now() WHERE operation_key=$1", [input.operationKey]);
        // A timeout can arrive after Telegram accepted the create. Recover only
        // by marker readback; never issue another createChannel request.
        try { return await this.reconcileUnlocked(input.operationKey); }
        catch { /* Keep the durable unknown state for the next bounded readback. */ }
        return this.result(input.operationKey);
      }
    });
  }
  private async reconcileUnlocked(key: string): Promise<ControlSetup> {
    const setup = await this.result(key);
    if (setup.state !== 'remote_unknown') return setup;
    const client = this.client(), matches: string[] = [];
    // Explicit operator reconciliation reads accessible private supergroups only.
    for await (const dialog of client.iterDialogs({ archived: 'keep', chunkSize: 100 })) {
      if (dialog.peer.type !== 'chat' || dialog.peer.chatType !== 'supergroup') continue;
      const full = await client.getFullChat(dialog.peer.id);
      if (full.bio.includes(setup.marker)) {
        await this.store.upsertDialog(normalizeDialog(dialog.peer, dialog.isArchived)); matches.push(String(dialog.peer.id));
      }
    }
    if (matches.length === 1) return this.finish(key, matches[0]!);
    if (matches.length > 1) await this.db.query("UPDATE control_setup_operations SET state='conflict',last_error='Multiple control groups match this operation marker',updated_at=now() WHERE operation_key=$1", [key]);
    return this.result(key);
  }
  async reconcile(key: string): Promise<ControlSetup> { this.client(); return this.db.withSessionLock('antseed:control-setup', () => this.reconcileUnlocked(key)); }
}

export class DurableControlBus implements ControlBus {
  private readonly subscribers = new Set<(message: ControlMessage) => Promise<void>>();
  private readonly intake: ChatIntake | null;
  constructor(private readonly db: PgDatabase, private readonly telegram: TelegramPort, store?: TelegramStore, private readonly ready?: () => Promise<void>) { this.intake = store ? new ChatIntake(db, store, telegram) : null; }
  async status(): Promise<ServiceStatus> {
    const row = (await this.db.query("SELECT EXISTS(SELECT 1 FROM chats WHERE is_control) AS configured,(SELECT count(*) FROM control_setup_operations WHERE state='remote_unknown') AS unknown,(SELECT count(*) FROM control_inbox WHERE state<>'done') AS inbox,(SELECT count(*) FROM control_outbox WHERE state='failed' AND attempts>=10) AS failed")).rows[0]!;
    const intake = this.intake ? (await this.db.query("SELECT count(*) FILTER(WHERE decision='pending') AS pending,count(*) FILTER(WHERE decision='pending' AND delivery_state<>'sent') AS queued,count(*) FILTER(WHERE decision='pending' AND delivery_state='failed' AND attempts>=10) AS failed FROM chat_intake_requests")).rows[0] : null;
    const code = Number(row['unknown']) ? 'control_setup_unknown' : !row['configured'] ? 'control_chat_missing' : Number(row['failed']) || Number(intake?.['failed'] ?? 0) ? 'control_delivery_failed' : Number(row['inbox']) ? 'control_replies_pending' : null;
    return { state: code ? 'degraded' : 'ready', code, detail: code === 'control_setup_unknown' ? 'Group creation outcome unknown; reconcile its operation key before creating another group' : code === 'control_chat_missing' ? 'Configure an operational control group to deliver pending proposals' : code === 'control_delivery_failed' ? 'Control delivery exhausted bounded retries; inspect persisted outbox and reconcile message receipts' : code === 'control_replies_pending' ? `${row['inbox']} durable control replies await workflow processing` : `Operational control group configured${intake ? `; ${intake['pending']} chats await intake approval (${intake['queued']} requests queued)` : ''}`, checkedAt: new Date().toISOString() };
  }
  subscribe(handler: (message: ControlMessage) => Promise<void>): () => void { this.subscribers.add(handler); return () => { this.subscribers.delete(handler); }; }
  async enqueueProposal(tx: SqlExecutor, input: Parameters<ControlBus['enqueueProposal']>[1]): Promise<void> {
    if (!(await tx.query('SELECT 1 FROM chats WHERE id=$1 AND is_control', [input.chatId])).rowCount) throw new DomainError('not_configured', 'Configure a control group before proposal delivery');
    let randomId = 0n; while (randomId === 0n) randomId = randomBytes(8).readBigInt64BE();
    const marker = `[antseed-proposal:${input.proposalId}]`;
    await tx.query('INSERT INTO control_outbox(proposal_id,chat_id,random_id,text) VALUES($1,$2,$3,$4) ON CONFLICT(proposal_id,chat_id) DO NOTHING', [input.proposalId, input.chatId, randomId.toString(), input.text.includes(marker) ? input.text : `${input.text}\n\n${marker}`]);
  }
  async tick(): Promise<void> {
    if ((await this.telegram.status()).state !== 'ready') return;
    await this.ready?.();
    await this.db.withSessionLock('antseed:control-worker', async () => {
      if (this.subscribers.size || this.intake) await this.deliverOne();
      await this.sendOne();
      await this.intake?.sendOne();
    });
  }
  private async deliverOne(): Promise<void> {
    const token = randomUUID();
    const row = await this.db.transaction(async (tx) => {
      const item = (await tx.query("SELECT i.* FROM control_inbox i JOIN chats c ON c.id=i.chat_id WHERE c.is_control AND i.state<>'done' AND (i.lease_until IS NULL OR i.lease_until<now()) ORDER BY i.sent_at,i.message_id FOR UPDATE OF i SKIP LOCKED LIMIT 1")).rows[0];
      if (!item) return null;
      await tx.query("UPDATE control_inbox SET state='running',claim_token=$3,lease_until=now()+interval '30 seconds',attempts=attempts+1 WHERE chat_id=$1 AND message_id=$2", [item['chat_id'], item['message_id'], token]); return item;
    });
    if (!row) return;
    try {
      const message: ControlMessage = { chatId: String(row['chat_id']), messageId: Number(row['message_id']), senderId: row['sender_id'] == null ? null : String(row['sender_id']), replyToMessageId: row['reply_to_id'] as number | null, text: String(row['text']), sentAt: new Date(row['sent_at'] as Date).toISOString() };
      if (!await this.intake?.handle(message)) for (const handler of this.subscribers) await handler(message);
      await this.db.query("UPDATE control_inbox SET state='done',claim_token=NULL,lease_until=NULL,last_error=NULL WHERE chat_id=$1 AND message_id=$2 AND claim_token=$3 AND lease_until>now()", [message.chatId, message.messageId, token]);
    } catch {
      await this.db.query("UPDATE control_inbox SET state='pending',claim_token=NULL,lease_until=now()+LEAST(attempts*2,60)*interval '1 second',last_error='Control handler unavailable; decision retained for retry' WHERE chat_id=$1 AND message_id=$2 AND claim_token=$3 AND lease_until>now()", [row['chat_id'], row['message_id'], token]);
    }
  }
  private async sendOne(): Promise<void> {
    const token = randomUUID();
    const row = await this.db.transaction(async (tx) => {
      const item = (await tx.query("SELECT o.* FROM control_outbox o JOIN chats c ON c.id=o.chat_id JOIN proposals p ON p.id=o.proposal_id JOIN tickets t ON t.id=p.ticket_id JOIN chats source ON source.id=t.chat_id WHERE c.is_control AND p.decision='pending' AND p.apply_state='not_requested' AND source.inclusion='included' AND NOT source.is_control AND source.policy_version=p.source_policy_version AND source.mapping_version=p.source_mapping_version AND t.stage_version=p.source_stage_version AND NOT EXISTS(SELECT 1 FROM proposal_evidence pe JOIN evidence e ON e.id=pe.evidence_id JOIN messages m ON (m.chat_id,m.id)=(e.chat_id,e.message_id) WHERE pe.proposal_id=p.id AND (e.invalidated_at IS NOT NULL OR m.deleted_at IS NOT NULL OR m.version<>e.message_version)) AND o.state<>'sent' AND o.attempts<10 AND (o.lease_until IS NULL OR o.lease_until<now()) ORDER BY o.created_at FOR UPDATE OF o SKIP LOCKED LIMIT 1")).rows[0];
      if (!item) return null;
      await tx.query("UPDATE control_outbox SET state='sending',claim_token=$2,lease_until=now()+interval '30 seconds',attempts=attempts+1 WHERE id=$1", [item['id'], token]); return item;
    });
    if (!row) return;
    try {
      if (Number(row['attempts']) > 0) {
        const chatId = String(row['chat_id']), self = await this.telegram.authorizedSelf();
        const history = await this.telegram.getHistory(chatId, { chatId, nextMessageId: null, nextDate: null, status: 'pending', importedCount: 0, lastError: null, updatedAt: new Date().toISOString(), generation: 0, leaseUntil: null }, 100);
        const matches = history.messages.filter((m) => m.senderId === self && m.text === row['text']);
        if (matches.length > 1) throw new DomainError('conflict', 'Multiple control delivery receipts need reconciliation');
        if (matches.length === 1) {
          await this.db.query("UPDATE control_outbox SET state='sent',message_id=$2,claim_token=NULL,lease_until=NULL,last_error=NULL WHERE id=$1 AND claim_token=$3 AND lease_until>now()", [row['id'], matches[0]!.id, token]);
          return;
        }
      }
      const result = await this.telegram.sendControlMessage({ chatId: String(row['chat_id']), text: String(row['text']), randomId: String(row['random_id']) });
      await this.db.query("UPDATE control_outbox SET state='sent',message_id=$2,claim_token=NULL,lease_until=NULL,last_error=NULL WHERE id=$1 AND claim_token=$3 AND lease_until>now()", [row['id'], result.messageId, token]);
    } catch {
      await this.db.query("UPDATE control_outbox SET state='failed',claim_token=NULL,lease_until=now()+LEAST(attempts*5,300)*interval '1 second',last_error='Delivery outcome unknown; stable random ID retained for retry/readback' WHERE id=$1 AND claim_token=$2 AND lease_until>now()", [row['id'], token]);
    }
  }
}
