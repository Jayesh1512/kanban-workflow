import { randomBytes, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { SqlExecutor, ControlMessage, TelegramPort } from '../shared/ports.js';
import { DomainError } from '../shared/api.js';
import type { PgDatabase } from '../platform/database.js';
import type { TelegramStore } from './store.js';
import { crmFirstEnabled } from '../shared/crm-first.js';

/** Metadata only: never copy a business message into an intake request. */
export async function queueIntake(tx: SqlExecutor, chatId: string, manual = false): Promise<void> {
  await tx.query(`INSERT INTO chat_intake_requests(chat_id,policy_version)
    SELECT id,policy_version FROM chats WHERE id=$1 AND inclusion='undecided' AND NOT is_control AND ($2 OR intake_origin='new')
    ON CONFLICT(chat_id) WHERE decision='pending' DO UPDATE
    SET priority_at=CASE WHEN $2 THEN now() ELSE chat_intake_requests.priority_at END`, [chatId, manual]);
}

/** Same durable control worker, separate request kind from lane proposals. */
export class ChatIntake {
  constructor(private readonly db: PgDatabase, private readonly store: TelegramStore, private readonly telegram: TelegramPort) {}
  async handle(message: ControlMessage): Promise<boolean> {
    if (!message.replyToMessageId || !/^(approve|reject)\s*[.!]?$/i.test(message.text.trim())) return false;
    if (!(await this.db.query('SELECT 1 FROM chats WHERE id=$1 AND is_control', [message.chatId])).rowCount) return false;
    const ref = (await this.db.query('SELECT id,chat_id FROM chat_intake_requests WHERE control_chat_id=$1 AND message_id=$2', [message.chatId, message.replyToMessageId])).rows[0];
    if (!ref) {
      // An approve can arrive after Telegram accepts a request but before receipt
      // linkage is saved. Keep the durable inbox pending until send readback.
      if ((await this.db.query(`SELECT 1 FROM chat_intake_requests WHERE control_chat_id=$1 AND decision='pending'
        AND message_id IS NULL AND attempts>0 AND delivery_state IN ('sending','failed') LIMIT 1`, [message.chatId])).rowCount)
        throw new DomainError('upstream_unavailable', 'Intake delivery receipt is being reconciled', true);
      return false;
    }
    await this.db.transaction(async (tx) => {
      const chat = await this.store.lockedChat(tx, String(ref['chat_id']));
      const row = (await tx.query('SELECT * FROM chat_intake_requests WHERE id=$1 FOR UPDATE', [ref['id']])).rows[0]!;
      if (row['decision'] !== 'pending') return;
      if (chat.isControl || chat.inclusion !== 'undecided' || chat.policyVersion !== Number(row['policy_version'])
        || !(await tx.query('SELECT 1 FROM chats WHERE id=$1 AND is_control', [message.chatId])).rowCount) {
        await tx.query("UPDATE chat_intake_requests SET decision='cancelled',decided_at=now() WHERE id=$1", [row['id']]); return;
      }
      const approve = /^approve/i.test(message.text.trim());
      await this.store.changeInclusion(tx, chat, approve ? 'included' : 'excluded');
      if (approve && chat.mappingStatus !== 'non_company' && !await crmFirstEnabled(tx)) {
        // Explicit intake approval is enough to create a visible prospect. Company
        // identity stays unknown until sourced; the projector owns remote creation.
        await tx.query(`INSERT INTO tickets(chat_id,company_id,kind)
          VALUES($1,$2,CASE WHEN $2::uuid IS NULL THEN 'contact_prospect' ELSE 'company' END)
          ON CONFLICT(chat_id) DO NOTHING`, [chat.id, chat.companyId]);
      }
      await tx.query("UPDATE chat_intake_requests SET decision=$2,decision_origin='telegram',operator_reason=NULL,decided_at=now(),decided_message_id=$3 WHERE id=$1", [row['id'], approve ? 'approved' : 'rejected', message.messageId]);
    });
    return true;
  }
  async sendOne(): Promise<void> {
    const token = randomUUID();
    const row = await this.db.transaction(async (tx): Promise<QueryResultRow | null> => {
      const control = (await tx.query('SELECT id FROM chats WHERE is_control')).rows[0];
      if (!control) return null;
      // Five unresolved delivered requests maximum; new live activity/manual
      // requests are prioritized. At most one new request each thirty seconds.
      const item = (await tx.query(`SELECT r.*,c.title,c.kind,c.username FROM chat_intake_requests r JOIN chats c ON c.id=r.chat_id
        WHERE r.decision='pending' AND c.inclusion='undecided' AND NOT c.is_control AND c.policy_version=r.policy_version
        AND (r.attempts<10 OR r.control_chat_id IS DISTINCT FROM $1) AND (r.lease_until IS NULL OR r.lease_until<now())
        AND (r.delivery_state<>'sent' OR r.control_chat_id IS DISTINCT FROM $1)
        AND (r.control_chat_id=$1 AND r.attempts>0 OR (
          (SELECT count(*) FROM chat_intake_requests WHERE decision='pending' AND control_chat_id=$1 AND attempts>0)<5
          AND NOT EXISTS(SELECT 1 FROM app_settings WHERE key='telegram:intake:last-send' AND (value->>'at')::timestamptz>now()-interval '30 seconds')))
        ORDER BY (r.attempts>0) DESC,r.priority_at DESC,r.created_at,r.id FOR UPDATE OF r SKIP LOCKED LIMIT 1`, [control['id']])).rows[0];
      if (!item) return null;
      const changed = String(item['control_chat_id']) !== String(control['id']);
      let randomId = String(item['random_id']);
      if (changed && item['control_chat_id'] != null) { let next = 0n; while(next === 0n) next = randomBytes(8).readBigInt64BE(); randomId = next.toString(); }
      const text = changed || !item['text'] ? `Add this chat to AntSeed CRM?\n\n${String(item['title']).replace(/[\r\n]/g,' ').slice(0,200)}\nType: ${item['kind']} · Chat ID: ${item['chat_id']}\n${item['username'] ? `@${String(item['username']).slice(0,64)}\n` : ''}\nReply to THIS message with approve to add this CRM conversation and start import/analysis.\nReply reject to leave it out. No reply = not imported.\nThis creates no Work ticket. CRM stage changes and concrete Work actions need separate Telegram approval.\n\n[antseed-intake:${item['id']}]` : String(item['text']);
      await tx.query(`UPDATE chat_intake_requests SET delivery_state='sending',control_chat_id=$2,text=$3,random_id=$6,
        message_id=CASE WHEN $5 THEN NULL ELSE message_id END,claim_token=$4,lease_until=now()+interval '30 seconds',attempts=CASE WHEN $5 THEN 1 ELSE attempts+1 END WHERE id=$1`, [item['id'], control['id'], text, token, changed, randomId]);
      await tx.query("INSERT INTO app_settings(key,value) VALUES('telegram:intake:last-send',jsonb_build_object('at',now())) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
      return { ...item, random_id: randomId, control_chat_id: control['id'], text, attempts: changed ? 0 : item['attempts'] };
    });
    if (!row) return;
    try {
      let messageId: number | null = null;
      if (Number(row['attempts']) > 0) {
        const self = await this.telegram.authorizedSelf(), chatId = String(row['control_chat_id']);
        const history = await this.telegram.getHistory(chatId, { chatId, nextMessageId: null, nextDate: null, status: 'pending', importedCount: 0, lastError: null, updatedAt: new Date().toISOString(), generation: 0, leaseUntil: null }, 100);
        const matches = history.messages.filter((m) => m.senderId === self && m.text === row['text']);
        if (matches.length > 1) throw new DomainError('conflict', 'Multiple intake receipts require reconciliation');
        messageId = matches[0]?.id ?? null;
      }
      if (messageId === null) messageId = (await this.telegram.sendControlMessage({ chatId: String(row['control_chat_id']), text: String(row['text']), randomId: String(row['random_id']) })).messageId;
      await this.db.query(`UPDATE chat_intake_requests SET delivery_state='sent',message_id=$2,claim_token=NULL,lease_until=NULL,last_error=NULL
        WHERE id=$1 AND claim_token=$3 AND lease_until>now()`, [row['id'], messageId, token]);
    } catch {
      await this.db.query(`UPDATE chat_intake_requests SET delivery_state='failed',claim_token=NULL,lease_until=now()+LEAST(attempts*5,300)*interval '1 second',last_error='Delivery outcome unknown; stable random ID retained for readback'
        WHERE id=$1 AND claim_token=$2 AND lease_until>now()`, [row['id'], token]);
    }
  }
}
