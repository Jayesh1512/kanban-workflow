import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parse } from 'dotenv';
import { migrate, PgDatabase } from '../src/platform/database.js';
import type { AnalysisInput, Extraction, JevDecision, ProviderProvenance } from '../src/shared/domain.js';
import { SqlAnalysisQueue, inputHash } from '../src/workflow/analysis.js';
import { RecordsRepository } from '../src/workflow/records.js';

type Source = { message_id: string; revision: number; sent_at: string; observed_at: string; sender_id: string; text: string | null; event: string; source_kind: string; evidence_id: string; forwarded_origin?: { display_name: string; original_sent_at: string } };
type Case = { case_id: string; language: string; chat: { chat_id: string }; messages: Source[]; expected: { board_must_remain_unchanged_before_approval: boolean } };
export const corpus = JSON.parse(readFileSync(new URL('./fixtures/relationship-cases.json', import.meta.url), 'utf8')) as { cases: Case[]; participants: Array<{ participant_id: string; display_name: string }> };
export function uuid(value: string): string { const h = createHash('sha256').update(value).digest('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`; }
/** Neutral corpus -> source DTOs only. No model, classifier, expected lane or expected mapping is synthesized. */
export function sourceInput(id: string, revision?: number): AnalysisInput {
  const c = corpus.cases.find((c) => c.case_id === id)!; const s = revision ? c.messages.find((s) => s.revision === revision)! : c.messages.at(-1)!;
  const sender = { id: s.sender_id, kind: 'user' as const, names: [corpus.participants.find((p) => p.participant_id === s.sender_id)!.display_name], usernames: [], visiblePhones: [], visibleEmails: [], observedAt: s.observed_at };
  const m: AnalysisInput['messages'][number] = { chatId: c.chat.chat_id, id: Number(s.message_id), senderId: s.sender_id, sender, peer: { ...sender, id: c.chat.chat_id, kind: 'chat', names: [] }, text: s.text ?? '', sentAt: s.sent_at, editedAt: s.event === 'edit' ? s.observed_at : null, deletedAt: s.event === 'delete' ? s.observed_at : null, version: s.revision, replyToId: null, sourceUrl: null,
    forward: { isForwarded: s.source_kind === 'forwarded', sourceKind: s.source_kind === 'forwarded' ? 'forwarded' : 'own', originPeer: null, originName: s.forwarded_origin?.display_name ?? null, originDate: s.forwarded_origin?.original_sent_at ?? null, originMessageId: null } };
  return { jobId: uuid(`job-${id}`), chat: { id: c.chat.chat_id, kind: 'supergroup', title: 'QA synthetic source', username: null, archived: false, inclusion: 'included', isControl: false, policyVersion: 0, mappingStatus: 'unresolved', companyId: null, mappingVersion: 0 }, messages: [m], evidence: [{ id: uuid(s.evidence_id), chatId: c.chat.chat_id, messageId: m.id, messageVersion: m.version, excerpt: m.text, observedAt: s.observed_at, invalidatedAt: m.deletedAt, sourceUrl: null }], companies: [], ticket: null, timezone: 'Asia/Kolkata' };
}
/** Caller-authored extraction echo, for storage/transport only; deliberately performs no semantic interpretation. */
export function echoExtraction(input: AnalysisInput): Extraction {
  const e = input.evidence[0]!;
  return { companyCandidates: [], companies: [], contacts: [], dates: [], summary: input.messages[0]!.text, substantive: true, evidenceIds: [e.id], facts: [{ localKey: 'source', answersLocalKey: null, kind: 'fact', text: e.excerpt, actor: { party: 'unknown', contactId: null, displayName: null }, state: 'open', evidenceIds: [e.id], dates: [] }] };
}
export function provenance(provider: 'openai' | 'vercel' = 'openai'): ProviderProvenance { return { provider, model: provider === 'openai' ? 'gpt-6.1-sol' : 'typesafe-ai/jev', schemaVersion: provider === 'openai' ? 'extraction.v1' : 'jev.antseed.v1', requestId: 'qa-synthetic', usage: {}, completedAt: '2026-10-21T00:00:00Z' }; }
export function decision(input: AnalysisInput, companyId?: string): JevDecision {
  return { relevance: 'company', companyMatch: companyId ? { outcome: 'matched', companyId, confidence: 1 } : { outcome: 'ambiguous', candidates: [] }, workstream: 'Buyer', urgency: 'normal', lane: { outcome: 'no_change', reason: 'QA authored decision, not model inference', evidenceIds: input.evidence.map((e) => e.id) }, model: 'typesafe-ai/jev', diagnostics: { rubricVersion: 'jev.antseed.v1', answers: { company_match: { type: 'choice', choice: companyId ? 'existing_0' : 'ambiguous', confidence: 1, probabilities: companyId ? { existing_0: 1 } : { ambiguous: 1 } } } } };
}
export async function isolatedDatabase(project: string, allMigrations = false) {
  if (!/^antseed-qa-m1-[a-z0-9-]+$/.test(project)) throw new Error('Requires retained QA-owned Compose project');
  // Never log the generated runtime bundle or connection URL.
  const bundle = parse(execFileSync('docker', ['compose', '-p', project, '-f', 'compose.yaml', 'exec', '-T', 'backend', 'cat', '/run/antseed/runtime.env'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
  const url = new URL(bundle['DATABASE_URL']!); url.hostname = '127.0.0.1'; url.port = process.env['QA_M31_PG_PORT'] ?? '18433';
  const schema = `qa_m31_${randomUUID().replaceAll('-', '')}`;
  const admin = new PgDatabase(url.toString()); await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set('options', `-c search_path=${schema}`);
  let db = new PgDatabase(url.toString());
  if (allMigrations) await migrate(db);
  else { await db.query(readFileSync(new URL('../db/migrations/001_initial.sql', import.meta.url), 'utf8')); await db.query(readFileSync(new URL('../db/migrations/202610170003_contact_prospects.sql', import.meta.url), 'utf8')); }
  await db.query('INSERT INTO telegram_account(self_user_id) VALUES(990000099)');
  const peers: PgDatabase[] = [];
  return { get db() { return db; }, peer() { const p = new PgDatabase(url.toString()); peers.push(p); return p; }, async reopen() { await db.close(); db = new PgDatabase(url.toString()); return db; }, async close() { await Promise.all(peers.map((p) => p.close())); await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); } };
}
export async function seed(db: PgDatabase, input: AnalysisInput) {
  await db.query('INSERT INTO chats(id,kind,title,inclusion) VALUES($1,$2,$3,$4)', [input.chat.id, input.chat.kind, input.chat.title, input.chat.inclusion]);
  for (const m of input.messages) await db.query('INSERT INTO messages(chat_id,id,sender_id,sent_at,text,version,edited_at,deleted_at,sender_snapshot,peer_snapshot,forward_metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [m.chatId,m.id,m.senderId,m.sentAt,m.text,m.version,m.editedAt,m.deletedAt,m.sender,m.peer,m.forward]);
  return enqueue(db, input.chat.id, input.messages[0]!.id);
}
export async function enqueue(db: PgDatabase, chatId: string, messageId = 101) {
  const id = randomUUID();
  await db.query('INSERT INTO analysis_jobs(id,chat_id,policy_version,mapping_version,dedupe_key) SELECT $1::uuid,id,policy_version,mapping_version,$1::text FROM chats WHERE id=$2', [id, chatId]);
  await db.query('INSERT INTO analysis_job_messages SELECT $1,chat_id,id,version FROM messages WHERE chat_id=$2 AND id=$3', [id,chatId,messageId]); return id;
}
export async function checkpoint(queue: SqlAnalysisQueue, token: { id: string; claimToken: string }, customize?: (x: Extraction) => void) {
  const input = await queue.loadInput(token.id); const extraction = echoExtraction(input); customize?.(extraction);
  const value = { jobId: token.id, inputHash: inputHash(input), extraction, provenance: provenance() };
  await queue.saveExtraction(value, token.claimToken); return { input, value };
}
export async function company(db: PgDatabase, chatId?: string) {
  const r = (await db.query("INSERT INTO companies(canonical_name,aliases,workstream) VALUES('Cedar Relay',ARRAY['Cedar'],'Buyer') RETURNING id")).rows[0]!;
  if (chatId) await db.query("UPDATE chats SET company_id=$1,mapping_status='confirmed' WHERE id=$2", [r.id,chatId]);
  return String(r.id);
}
export const repository = (db: PgDatabase, instant = '2026-10-18T18:31:00Z') => new RecordsRepository(db, { now: () => new Date(instant) });
