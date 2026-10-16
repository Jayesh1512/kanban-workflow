import { createHash } from 'node:crypto';
import type { Database, SqlExecutor } from '../shared/ports.js';
import { DomainError } from '../shared/api.js';
import type { Chat, Company, Evidence, Message, Ticket } from '../shared/domain.js';

export function canonical(value: unknown): string {
  if (value === undefined) throw new DomainError('validation', 'Undefined command value');
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
export const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export const iso = (value: unknown): string => new Date(value as string | Date).toISOString();
export const nullableIso = (value: unknown): string | null => value == null ? null : iso(value);
export function assert(condition: unknown, code: ConstructorParameters<typeof DomainError>[0], message: string): asserts condition { if (!condition) throw new DomainError(code, message); }

/** One transaction and one advisory lock serialize equal idempotency scopes across processes. */
export async function command<T>(db: Database, scope: string, key: string, request: unknown, work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  assert(typeof key === 'string' && key.length > 0 && key.length <= 200, 'validation', 'Invalid idempotency key');
  const digest = hash(request);
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`command:${scope}:${key}`]);
    const previous = (await tx.query<{ request_hash: string; response: T }>('SELECT request_hash,response FROM idempotency_keys WHERE scope=$1 AND key=$2', [scope, key])).rows[0];
    if (previous) { assert(previous.request_hash === digest, 'conflict', 'Idempotency key has different input'); return previous.response; }
    const result = await work(tx);
    await tx.query('INSERT INTO idempotency_keys(scope,key,request_hash,response) VALUES($1,$2,$3,$4::jsonb)', [scope, key, digest, JSON.stringify(result)]);
    return result;
  });
}

export async function assertEvidence(tx: SqlExecutor, ids: string[], chatId?: string): Promise<void> {
  const unique = [...new Set(ids)]; if (!unique.length) return;
  const result = await tx.query(`SELECT e.id FROM evidence e JOIN messages m ON m.chat_id=e.chat_id AND m.id=e.message_id
    JOIN chats c ON c.id=e.chat_id WHERE e.id=ANY($1::uuid[]) AND e.invalidated_at IS NULL AND m.deleted_at IS NULL
    AND e.message_version=m.version AND c.inclusion='included' AND NOT c.is_control AND ($2::bigint IS NULL OR c.id=$2)`, [unique, chatId ?? null]);
  assert(result.rows.length === unique.length, 'conflict', 'Evidence is missing, stale, excluded or belongs to another chat');
}

export async function links(tx: SqlExecutor, table: 'company_evidence' | 'contact_evidence' | 'ticket_evidence' | 'fact_evidence' | 'role_evidence' | 'mapping_candidate_evidence' | 'mapping_history_evidence' | 'proposal_evidence', column: string, id: string, evidenceIds: string[], replace = true): Promise<void> {
  const columns = { company_evidence: 'company_id', contact_evidence: 'contact_id', ticket_evidence: 'ticket_id', fact_evidence: 'fact_id', role_evidence: 'role_id', mapping_candidate_evidence: 'candidate_id', mapping_history_evidence: 'history_id', proposal_evidence: 'proposal_id' };
  assert(columns[table] === column, 'internal', 'Invalid relationship column');
  if (replace) await tx.query(`DELETE FROM ${table} WHERE ${column}=$1`, [id]);
  if (evidenceIds.length) await tx.query(`INSERT INTO ${table}(${column},evidence_id) SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING`, [id, [...new Set(evidenceIds)]]);
}
export async function evidenceFor(tx: SqlExecutor, table: 'company_evidence' | 'contact_evidence' | 'ticket_evidence' | 'fact_evidence' | 'role_evidence', column: string, id: string): Promise<string[]> {
  const allowed = { company_evidence: 'company_id', contact_evidence: 'contact_id', ticket_evidence: 'ticket_id', fact_evidence: 'fact_id', role_evidence: 'role_id' };
  assert(allowed[table] === column, 'internal', 'Invalid relationship column');
  return (await tx.query<{ evidence_id: string }>(`SELECT l.evidence_id FROM ${table} l JOIN evidence e ON e.id=l.evidence_id
    JOIN messages m ON m.chat_id=e.chat_id AND m.id=e.message_id JOIN chats c ON c.id=e.chat_id
    WHERE l.${column}=$1 AND e.invalidated_at IS NULL AND e.message_version=m.version AND m.deleted_at IS NULL
    AND c.inclusion='included' AND NOT c.is_control ORDER BY l.evidence_id`, [id])).rows.map((r) => r.evidence_id);
}
export type Row = Record<string, unknown>;
export function chatRow(r: Row): Chat { return { id: String(r.id), kind: r.kind as Chat['kind'], title: String(r.title), username: r.username as string | null,
  archived: Boolean(r.archived), inclusion: r.inclusion as Chat['inclusion'], isControl: Boolean(r.is_control), policyVersion: Number(r.policy_version),
  mappingStatus: r.mapping_status as Chat['mappingStatus'], companyId: r.company_id as string | null, mappingVersion: Number(r.mapping_version) }; }
export function messageRow(r: Row): Message { return { chatId: String(r.chat_id), id: Number(r.id), senderId: r.sender_id == null ? null : String(r.sender_id),
  sentAt: iso(r.sent_at), editedAt: nullableIso(r.edited_at), deletedAt: nullableIso(r.deleted_at), text: String(r.text), replyToId: r.reply_to_id as number | null,
  sourceUrl: r.source_url as string | null, version: Number(r.version), sender: r.sender_snapshot as Message['sender'], peer: r.peer_snapshot as Message['peer'], forward: r.forward_metadata as Message['forward'] }; }
export function evidenceRow(r: Row): Evidence { return { id: String(r.id), chatId: String(r.chat_id), messageId: Number(r.message_id), messageVersion: Number(r.message_version),
  excerpt: String(r.excerpt), sourceUrl: r.source_url as string | null, observedAt: iso(r.observed_at), invalidatedAt: nullableIso(r.invalidated_at) }; }
export async function companyRow(tx: SqlExecutor, r: Row): Promise<Company> { return { id: String(r.id), canonicalName: String(r.canonical_name), aliases: r.aliases as string[], domains: r.domains as string[],
  workstream: r.workstream as Company['workstream'], summary: String(r.summary), buyerIds: r.buyer_ids as string[], providerIds: r.provider_ids as string[], version: Number(r.version), evidenceIds: await evidenceFor(tx, 'company_evidence', 'company_id', String(r.id)) }; }
export async function ticketRow(tx: SqlExecutor, r: Row): Promise<Ticket> { return { id: String(r.id), chatId: String(r.chat_id), companyId: String(r.company_id), vikunjaTaskId: r.vikunja_task_id == null ? null : String(r.vikunja_task_id),
  lane: r.lane as Ticket['lane'], stageVersion: Number(r.stage_version), previousActiveLane: r.previous_active_lane as Ticket['previousActiveLane'], workstream: r.workstream as Ticket['workstream'],
  summary: String(r.summary), nextAction: r.next_action as string | null, followUpAt: nullableIso(r.follow_up_at), etaAt: nullableIso(r.eta_at), latestSubstantiveAt: nullableIso(r.latest_substantive_at),
  blockers: r.blockers as string[], contactIds: (await tx.query<{ contact_id: string }>('SELECT contact_id FROM ticket_contacts WHERE ticket_id=$1 ORDER BY contact_id', [r.id])).rows.map((r) => r.contact_id),
  evidenceIds: await evidenceFor(tx, 'ticket_evidence', 'ticket_id', String(r.id)), actionsVersion: Number(r.actions_version), actionsSource: r.actions_source as Ticket['actionsSource'], trackingState: r.tracking_state as Ticket['trackingState'] }; }

export function page(input: { cursor?: string; limit?: number }): { after: string | null; limit: number } {
  const limit = input.limit ?? 50; assert(Number.isInteger(limit) && limit > 0 && limit <= 200, 'validation', 'Invalid page limit');
  if (!input.cursor) return { after: null, limit };
  assert(/^[0-9a-f-]{36}$/i.test(input.cursor), 'validation', 'Invalid page cursor'); return { after: input.cursor, limit };
}
