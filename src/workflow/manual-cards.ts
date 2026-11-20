import type { Ticket } from '../shared/domain.js';
import type { SqlExecutor } from '../shared/ports.js';
import { manualCardSchema, type ManualCardInput } from '../shared/schemas.js';
import { assert, ticketRow } from './sql.js';

/** A person creates Work for a conversation the pipeline cannot admit: an
 * excluded chat, or an offline channel such as WhatsApp with no imported
 * source. The reason is required because this overrides automatic intake. */
export { manualCardSchema };
export type { ManualCardInput };
type ChatRow = { id: string; policy_version: number; inclusion: string; is_control: boolean; company_id: string | null; mapping_status: string };

/** Shared by the operator HTTP route and the MCP tool. One transaction, one
 * durable idempotency key, and no fabricated Telegram approval. */
export async function createWorkCardTx(tx: SqlExecutor, input: ManualCardInput, actorId?: string): Promise<Ticket> {
  const previous = (await tx.query('SELECT * FROM tickets WHERE creation_key=$1', [input.idempotencyKey])).rows[0];
  if (previous) {
    assert(previous.next_action === input.title, 'conflict', 'Card creation key was reused with a different title');
    return ticketRow(tx, previous);
  }
  assert(!(input.chatId && input.chatTitle), 'validation', 'Provide an existing chat or a new conversation title, not both');
  assert(!(input.companyId && input.companyName), 'validation', 'Provide a company ID or a new company name, not both');

  let chat: ChatRow;
  if (input.chatId) {
    chat = (await tx.query<ChatRow>('SELECT * FROM chats WHERE id=$1 FOR UPDATE', [input.chatId])).rows[0]!;
    assert(chat, 'not_found', 'Chat not found');
    assert(!chat.is_control, 'excluded_chat', 'The control chat cannot become business content');
  } else {
    assert(input.chatTitle, 'validation', 'A new card needs a conversation title');
    // 'manual' is an offline channel label, not a Telegram kind. WhatsApp and
    // other sources use it until a real connector exists.
    chat = (await tx.query<ChatRow>(`INSERT INTO chats(id,kind,title,inclusion,intake_origin)
      VALUES(nextval('manual_chat_ids'),'manual',$1,'undecided','new') RETURNING *`, [input.chatTitle])).rows[0]!;
  }

  // Operator admission. A pending automatic request can no longer apply: the
  // person just decided the same chat with an explicit reason.
  await tx.query("UPDATE chat_intake_requests SET decision='cancelled',claim_token=NULL,lease_until=NULL WHERE chat_id=$1 AND decision='pending'", [chat.id]);
  if (chat.inclusion !== 'included') {
    chat = (await tx.query<ChatRow>('UPDATE chats SET inclusion=\'included\',policy_version=policy_version+1,updated_at=now() WHERE id=$1 RETURNING *', [chat.id])).rows[0]!;
  }
  await tx.query(`INSERT INTO chat_intake_requests(chat_id,policy_version,decision,decision_origin,operator_reason,decided_at,delivery_state)
    VALUES($1,$2,'approved','operator',$3,now(),'sent')`, [chat.id, chat.policy_version, input.reason]);

  let companyId: string | null = chat.company_id == null ? null : String(chat.company_id);
  let workstream = input.workstream ?? null;
  if (input.companyId) {
    const company = (await tx.query('SELECT * FROM companies WHERE id=$1', [input.companyId])).rows[0];
    assert(company, 'not_found', 'Company not found'); companyId = String(company.id);
    workstream ??= company.workstream as typeof workstream;
  } else if (input.companyName) {
    const known = (await tx.query('SELECT * FROM companies WHERE lower(btrim(canonical_name))=lower(btrim($1)) ORDER BY created_at,id LIMIT 1', [input.companyName])).rows[0];
    const company = known ?? (await tx.query('INSERT INTO companies(canonical_name) VALUES($1) RETURNING *', [input.companyName])).rows[0]!;
    companyId = String(company.id); workstream ??= company.workstream as typeof workstream;
  } else if (companyId) {
    const company = (await tx.query('SELECT workstream FROM companies WHERE id=$1', [companyId])).rows[0];
    workstream ??= company?.workstream as typeof workstream;
  }
  // The chat CHECK ties a confirmed mapping to a company, so both change together.
  if (companyId && (String(chat.company_id ?? '') !== companyId || chat.mapping_status !== 'confirmed')) {
    chat = (await tx.query<ChatRow>(`UPDATE chats SET company_id=$2,mapping_status='confirmed',mapping_version=mapping_version+1,updated_at=now()
      WHERE id=$1 RETURNING *`, [chat.id, companyId])).rows[0]!;
  }
  const kind = companyId ? 'company' : 'contact_prospect';
  const ownerId = input.ownerId ?? actorId ?? null;
  // A chat keeps one legacy card. Reuse it instead of failing the unique index,
  // and record that the person now owns its content. The probe reads the
  // proposal column through JSON so a schema without it is still a legacy row.
  const legacy = (await tx.query(`SELECT *,to_jsonb(tickets)->>'creation_proposal_id' AS proposal_id
    FROM tickets WHERE chat_id=$1`, [chat.id])).rows.find((row) => (row.proposal_id ?? null) === null);
  const row = legacy
    ? (await tx.query(`UPDATE tickets SET company_id=$2,kind=$3,lane=$4,workstream=coalesce($5,workstream),summary=$6,next_action=$7,
        tracking_state='active',actions_source='manual',owner_id=coalesce(owner_id,$8),creation_origin='manual',creation_channel=$11,creation_key=$9,creation_note=$10,updated_at=now()
        WHERE id=$1 RETURNING *`,
      [legacy.id, companyId, kind, input.lane ?? legacy.lane, workstream, input.summary ?? String(legacy.summary), input.title, ownerId, input.idempotencyKey, input.reason, input.channel])).rows[0]!
    : (await tx.query(`INSERT INTO tickets(chat_id,company_id,kind,lane,workstream,summary,next_action,tracking_state,actions_source,owner_id,creation_origin,creation_channel,creation_key,creation_note)
        VALUES($1,$2,$3,$4,$5,$6,$7,'active','manual',$8,'manual',$11,$9,$10) RETURNING *`,
      [chat.id, companyId, kind, input.lane ?? 'To be started', workstream ?? 'Others', input.summary ?? '', input.title, ownerId, input.idempotencyKey, input.reason, input.channel])).rows[0]!;
  if (actorId) {
    await tx.query(`INSERT INTO workspace_audit(actor_id,action,resource_id,before_value,after_value)
      VALUES($1,'work.create.manual',$2,$3,$4)`, [actorId, String(row.id), legacy ? JSON.stringify({ chatId: String(chat.id), ticketId: String(legacy.id), origin: legacy.creation_origin ?? 'pipeline' }) : null,
      JSON.stringify({ chatId: String(chat.id), title: input.title, companyId, channel: input.channel, reason: input.reason })]);
  }
  return ticketRow(tx, row);
}
