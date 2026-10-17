import { randomUUID } from 'node:crypto';
import type { AnalysisInput, ExtractionCheckpoint, JevDecision, ProviderProvenance } from '../shared/domain.js';
import type { AnalysisJob, AnalysisQueue, Clock, Database, ProviderResult, SqlExecutor } from '../shared/ports.js';
import { validateExtraction, EXTRACTION_VERSION } from '../intelligence/validation.js';
import { strongChoice } from '../intelligence/jev.js';
import { assert, assertEvidence, chatRow, command, companyRow, evidenceRow, hash, links, messageRow, ticketRow, type Row } from './sql.js';
import { ensureTicketTx, getCompanyTx, getContactTx, refreshInferredActions, replaceDates, writeCompanyTx, writeContactTx } from './records.js';

export function inputHash(input: AnalysisInput): string { return hash({ ...input, jobId: null, schemaVersion: EXTRACTION_VERSION }); }
const idFrom = (value: unknown) => { const h = hash(value); return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
export interface AnalysisHooks {
  onDecision?: (tx: SqlExecutor, input: { jobId: string; ticketId: string; expectedStageVersion: number; decision: JevDecision }) => Promise<void>;
  onReplay?: (tx: SqlExecutor) => Promise<void>;
}

export class SqlAnalysisQueue implements AnalysisQueue {
  constructor(readonly db: Database, readonly clock: Clock = { now: () => new Date() }, readonly timezone = 'Asia/Kolkata', readonly hooks: AnalysisHooks = {}) {}
  async claim(input: { workerId: string; leaseMs: number }): Promise<AnalysisJob | null> {
    assert(input.workerId.length > 0 && Number.isFinite(input.leaseMs) && input.leaseMs > 0 && input.leaseMs <= 3_600_000, 'validation', 'Invalid analysis lease');
    const now = this.clock.now(); const token = randomUUID();
    return this.db.transaction(async (tx) => {
      await tx.query(`UPDATE analysis_jobs j SET status='cancelled',worker_id=NULL,lease_until=NULL,last_error='source_changed'
        WHERE (j.status IN ('pending','retry','provider_unavailable') OR (j.status='running' AND j.lease_until<=$1)) AND (
        EXISTS(SELECT 1 FROM chats c WHERE c.id=j.chat_id AND (c.inclusion<>'included' OR c.is_control OR c.policy_version<>j.policy_version OR c.mapping_version<>j.mapping_version))
        OR EXISTS(SELECT 1 FROM analysis_job_messages s LEFT JOIN messages m ON m.chat_id=s.chat_id AND m.id=s.message_id WHERE s.job_id=j.id AND (m.version IS NULL OR m.version<>s.message_version OR m.deleted_at IS NOT NULL)))`, [now]);
      const row = (await tx.query(`SELECT j.* FROM analysis_jobs j JOIN chats c ON c.id=j.chat_id
        WHERE c.inclusion='included' AND NOT c.is_control AND j.policy_version=c.policy_version AND j.mapping_version=c.mapping_version
        AND ((j.status IN ('pending','retry') AND (j.retry_at IS NULL OR j.retry_at<=$1)) OR (j.status='running' AND j.lease_until<=$1))
        ORDER BY j.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1`, [now])).rows[0];
      if (!row) return null;
      const lease = new Date(now.getTime() + input.leaseMs);
      await tx.query("UPDATE analysis_jobs SET status='running',worker_id=$2,lease_until=$3,attempts=attempts+1,updated_at=$4 WHERE id=$1", [row.id, token, lease, now]);
      return { id: String(row.id), chatId: String(row.chat_id), policyVersion: Number(row.policy_version), mappingVersion: Number(row.mapping_version), status: 'running',
        claimToken: token, attempts: Number(row.attempts) + 1, leaseUntil: lease.toISOString(), retryAt: null, lastError: row.last_error as string | null };
    });
  }
  private async fenced(tx: SqlExecutor, id: string, token: string): Promise<Row> {
    const ref = (await tx.query('SELECT chat_id FROM analysis_jobs WHERE id=$1', [id])).rows[0];
    assert(ref, 'not_found', 'Analysis job not found');
    // Same lock order as platform correction/ingestion: chat before job, avoiding a cross-module deadlock.
    await tx.query('SELECT id FROM chats WHERE id=$1 FOR UPDATE', [ref.chat_id]);
    const job = (await tx.query('SELECT * FROM analysis_jobs WHERE id=$1 FOR UPDATE', [id])).rows[0];
    assert(job && job.status === 'running' && job.worker_id === token && job.lease_until && new Date(job.lease_until as string).getTime() > this.clock.now().getTime(), 'conflict', 'Analysis claim expired or was replaced');
    return job;
  }
  private async load(tx: SqlExecutor, id: string): Promise<AnalysisInput> {
    const job = (await tx.query('SELECT * FROM analysis_jobs WHERE id=$1', [id])).rows[0]; assert(job, 'not_found', 'Analysis job not found');
    const c = (await tx.query('SELECT * FROM chats WHERE id=$1 FOR UPDATE', [job.chat_id])).rows[0]; assert(c, 'not_found', 'Chat not found');
    assert(c.inclusion === 'included' && !c.is_control, 'excluded_chat', 'Analysis chat is not included');
    assert(Number(job.policy_version) === Number(c.policy_version) && Number(job.mapping_version) === Number(c.mapping_version), 'conflict', 'Analysis policy or mapping changed');
    const snapshots = (await tx.query(`SELECT s.message_id,s.message_version,m.version,m.deleted_at FROM analysis_job_messages s LEFT JOIN messages m ON m.chat_id=s.chat_id AND m.id=s.message_id WHERE s.job_id=$1`, [id])).rows;
    assert(snapshots.length > 0 && snapshots.every((m) => m.version === m.message_version && !m.deleted_at), 'conflict', 'Analysis message snapshot is stale or empty');
    // Immutable source snapshot bounds are checked in addition to a bounded current chat window.
    const rows = (await tx.query(`SELECT m.* FROM messages m WHERE m.chat_id=$1 AND m.deleted_at IS NULL AND (m.id IN (SELECT message_id FROM analysis_job_messages WHERE job_id=$2)
      OR m.id IN (SELECT id FROM messages WHERE chat_id=$1 AND deleted_at IS NULL ORDER BY sent_at DESC,id DESC LIMIT 100)) ORDER BY m.sent_at DESC,m.id DESC LIMIT 200`, [c.id, id])).rows;
    const required = new Set(snapshots.map((r) => Number(r.message_id)));
    const ordered = [...rows.filter((r) => required.has(Number(r.id))), ...rows.filter((r) => !required.has(Number(r.id)))];
    const selected: Row[] = []; let length = 0;
    for (const row of ordered) { const text = String(row.text).slice(0, 8000); if (length + text.length > 64000) continue; selected.push({ ...row, text }); length += text.length; }
    assert([...required].every((id) => selected.some((r) => Number(r.id) === id)), 'conflict', 'Source snapshot exceeds bounded analysis window; partition ingestion jobs');
    const messages = selected.map(messageRow).sort((a, b) => a.sentAt.localeCompare(b.sentAt) || a.id - b.id);
    assert(messages.length > 0, 'conflict', 'No current source messages');
    for (const m of messages) {
      if (!m.text.trim()) continue;
      const evidenceId = idFrom(['message-evidence', m.chatId, m.id, m.version]);
      await tx.query(`INSERT INTO evidence(id,chat_id,message_id,message_version,excerpt,source_url,observed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`, [evidenceId, m.chatId, m.id, m.version, m.text, m.sourceUrl, m.sentAt]);
    }
    const evidence = (await tx.query(`SELECT e.* FROM evidence e JOIN messages m ON m.chat_id=e.chat_id AND m.id=e.message_id WHERE e.chat_id=$1 AND e.message_id=ANY($2::int[])
      AND e.message_version=m.version AND e.invalidated_at IS NULL AND m.deleted_at IS NULL ORDER BY e.id`, [c.id, messages.map((m) => m.id)])).rows.map(evidenceRow);
    const companies = await Promise.all((await tx.query('SELECT * FROM companies ORDER BY id LIMIT 100')).rows.map((row) => companyRow(tx, row)));
    const ticket = (await tx.query('SELECT * FROM tickets WHERE chat_id=$1 FOR UPDATE', [c.id])).rows[0];
    const account = (await tx.query('SELECT self_user_id::text FROM telegram_account WHERE singleton')).rows[0];
    assert(account, 'not_configured', 'Telegram dataset account is not bound');
    // Singleton dataset account binding is immutable under the platform contract.
    return { jobId: id, chat: chatRow(c), messages, evidence, companies, ticket: ticket ? await ticketRow(tx, ticket) : null, timezone: this.timezone };
  }
  async loadInput(jobId: string): Promise<AnalysisInput> { return this.db.transaction((tx) => this.load(tx, jobId)); }
  async getExtraction(jobId: string): Promise<ExtractionCheckpoint | null> {
    return this.db.transaction(async (tx) => {
      const job = (await tx.query('SELECT * FROM analysis_jobs WHERE id=$1', [jobId])).rows[0]; assert(job, 'not_found', 'Analysis job not found');
      if (!job.extraction || !job.extraction_provenance) return null;
      const input = await this.load(tx, jobId);
      if (job.extraction_input_hash !== inputHash(input)) return null;
      return { jobId, extraction: validateExtraction(job.extraction, input), provenance: job.extraction_provenance as ProviderProvenance, inputHash: String(job.extraction_input_hash) };
    });
  }
  async saveExtraction(checkpoint: ExtractionCheckpoint, claimToken: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.fenced(tx, checkpoint.jobId, claimToken); const input = await this.load(tx, checkpoint.jobId);
      assert(checkpoint.inputHash === inputHash(input), 'conflict', 'Extraction input changed');
      const extraction = validateExtraction(checkpoint.extraction, input);
      assert(checkpoint.provenance.provider === 'openai' && checkpoint.provenance.schemaVersion === EXTRACTION_VERSION, 'validation', 'Invalid extraction provenance');
      // Replacing the checkpoint must not leave obsolete inferred facts from the same attempt.
      await this.saveFacts(tx, input, extraction);
      const updated = await tx.query(`UPDATE analysis_jobs SET extraction=$2::jsonb,extraction_provenance=$3::jsonb,extraction_input_hash=$4,updated_at=$5
        WHERE id=$1 AND worker_id=$6 AND status='running' AND lease_until>$5 RETURNING id`, [checkpoint.jobId, JSON.stringify(extraction), JSON.stringify(checkpoint.provenance), checkpoint.inputHash, this.clock.now(), claimToken]);
      assert(updated.rows.length === 1, 'conflict', 'Analysis lease expired during checkpoint save');
    });
  }
  private async saveFacts(tx: SqlExecutor, input: AnalysisInput, extraction: ExtractionCheckpoint['extraction']) {
    const ids = new Map(extraction.facts.map((f) => [f.localKey, idFrom(['fact', input.chat.id, f.kind, f.text, [...f.evidenceIds].sort()])]));
    for (const f of extraction.facts) {
      const id = ids.get(f.localKey)!;
      const existing = (await tx.query('SELECT source FROM facts WHERE id=$1 FOR UPDATE', [id])).rows[0]; if (existing?.source === 'manual') continue;
      await tx.query(`INSERT INTO facts(id,job_id,ticket_id,kind,text,actor_party,actor_contact_id,actor_display_name,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET job_id=EXCLUDED.job_id,ticket_id=COALESCE(EXCLUDED.ticket_id,facts.ticket_id),state=EXCLUDED.state,
        actor_party=EXCLUDED.actor_party,actor_contact_id=EXCLUDED.actor_contact_id,actor_display_name=EXCLUDED.actor_display_name,version=facts.version+1`, [id, input.jobId, input.ticket?.id ?? null, f.kind, f.text, f.actor.party, f.actor.contactId, f.actor.displayName, f.state]);
      await links(tx, 'fact_evidence', 'fact_id', id, f.evidenceIds);
      await replaceDates(tx, id, input.jobId, input.ticket?.id ?? null, f.dates, 'inferred');
    }
    for (const f of extraction.facts) {
      if (!f.answersLocalKey) continue;
      const id = ids.get(f.localKey)!; const target = ids.get(f.answersLocalKey)!;
      await tx.query("UPDATE facts SET answers_fact_id=$2 WHERE id=$1 AND source='inferred'", [id, target]);
      await tx.query("UPDATE facts SET state='answered',version=version+1 WHERE id=$1 AND source='inferred' AND state='open'", [target]);
    }
    // Standalone dates are retained as sourced facts too, with no fabricated instant or actor.
    for (const date of extraction.dates) {
      const id = idFrom(['date', input.chat.id, date]);
      const created = (await tx.query(`INSERT INTO facts(id,job_id,ticket_id,kind,text) VALUES($1,$2,$3,'action',$4) ON CONFLICT(id) DO NOTHING RETURNING id`, [id, input.jobId, input.ticket?.id ?? null, date.originalText])).rows[0];
      if (created) { await links(tx, 'fact_evidence', 'fact_id', id, date.evidenceIds); await replaceDates(tx, id, input.jobId, input.ticket?.id ?? null, [date], 'inferred'); }
    }
    const currentIds = [...ids.values(), ...extraction.dates.map((d) => idFrom(['date', input.chat.id, d]))];
    await tx.query("UPDATE facts SET state='withdrawn',version=version+1 WHERE job_id=$1 AND source='inferred' AND parent_fact_id IS NULL AND NOT(id=ANY($2::uuid[]))", [input.jobId, currentIds]);
  }
  async complete(jobId: string, decision: JevDecision, provenance: ProviderProvenance, claimToken: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const job = await this.fenced(tx, jobId, claimToken); const input = await this.load(tx, jobId);
      assert(job.extraction && job.extraction_input_hash === inputHash(input), 'conflict', 'Current extraction checkpoint is required');
      const extraction = validateExtraction(job.extraction, input);
      const supportedProvider = provenance.provider === 'vercel' || (provenance.provider === 'openai' && provenance.model === 'gpt-6-luna' && provenance.schemaVersion === 'openai.decisions.antseed.v1');
      assert(supportedProvider && decision.model === provenance.model, 'validation', 'Decision provenance does not match the configured decision model');
      const evidenceIds = [...new Set(extraction.evidenceIds)]; await assertEvidence(tx, [...evidenceIds, ...decision.lane.evidenceIds], input.chat.id);
      const match = decision.companyMatch;
      let companyId = input.chat.companyId;
      const manual = (await tx.query("SELECT 1 FROM mapping_history WHERE chat_id=$1 AND source<>'analysis' LIMIT 1", [input.chat.id])).rows.length > 0;
      if (!manual && decision.relevance === 'company' && strongChoice(decision.diagnostics.answers.company_match) && evidenceIds.length) {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['directory:analysis']);
        if (match.outcome === 'matched') {
          assert(input.companies.some((c) => c.id === match.companyId) && match.confidence >= 0.8, 'validation', 'Unsupported directory match'); companyId = match.companyId;
        } else if (match.outcome === 'new_company' && extraction.companies.length === 1) {
          const c = extraction.companies[0]!;
          const duplicates = (await tx.query(`SELECT * FROM companies WHERE lower(canonical_name)=lower($1) OR EXISTS(SELECT 1 FROM unnest(aliases) a WHERE lower(a)=lower($1)) OR domains && $2::text[]`, [c.canonicalName, c.domains.map((d) => d.toLowerCase())])).rows;
          if (duplicates.length <= 1) {
            companyId = duplicates.length ? String(duplicates[0]!.id) : (await writeCompanyTx(tx, { ...c, idempotencyKey: jobId, workstream: decision.workstream, summary: extraction.summary })).id;
          }
        }
      }
      const canConfirm = companyId !== null && (input.chat.mappingStatus === 'confirmed' || decision.relevance === 'company');
      if (!manual && canConfirm && (companyId !== input.chat.companyId || input.chat.mappingStatus !== 'confirmed')) {
        const mappingVersion = input.chat.mappingVersion + 1;
        await tx.query("UPDATE chats SET company_id=$2,mapping_status='confirmed',mapping_version=$3,updated_at=now() WHERE id=$1", [input.chat.id, companyId, mappingVersion]);
        const history = (await tx.query<{ id: string }>(`INSERT INTO mapping_history(chat_id,company_id,mapping_status,version,reason,source) VALUES($1,$2,'confirmed',$3,$4,'analysis') RETURNING id`, [input.chat.id, companyId, mappingVersion, `Jev supported ${match.outcome} company association`])).rows[0]!;
        await links(tx, 'mapping_history_evidence', 'history_id', history.id, evidenceIds);
        await tx.query("UPDATE analysis_jobs SET status='cancelled',lease_until=NULL,worker_id=NULL,last_error='mapping_changed' WHERE chat_id=$1 AND id<>$2 AND status<>'completed'", [input.chat.id, jobId]);
        await tx.query("UPDATE proposals SET apply_state='stale',last_error='mapping_changed' WHERE ticket_id IN(SELECT id FROM tickets WHERE chat_id=$1) AND apply_state<>'applied'", [input.chat.id]);
        if (input.ticket && input.ticket.companyId !== companyId) {
          await tx.query('DELETE FROM ticket_contacts WHERE ticket_id=$1', [input.ticket.id]); await tx.query('DELETE FROM ticket_evidence WHERE ticket_id=$1', [input.ticket.id]);
          await tx.query('UPDATE facts SET ticket_id=NULL WHERE ticket_id=$1 AND job_id<>$2', [input.ticket.id, jobId]);
        }
      }
      if (canConfirm) {
        const ticket = await ensureTicketTx(tx, input.chat.id);
        const selectedCompany = await getCompanyTx(tx, ticket.companyId);
        const extracted = extraction.companies.find((c) => c.canonicalName.toLowerCase() === selectedCompany.canonicalName.toLowerCase());
        if (extracted) await writeCompanyTx(tx, { ...selectedCompany, idempotencyKey: jobId, aliases: [...new Set([...selectedCompany.aliases, ...extracted.aliases])], domains: [...new Set([...selectedCompany.domains, ...extracted.domains])], buyerIds: [...new Set([...selectedCompany.buyerIds, ...extracted.buyerIds])], providerIds: [...new Set([...selectedCompany.providerIds, ...extracted.providerIds])], workstream: decision.workstream ?? selectedCompany.workstream, evidenceIds: [...new Set([...selectedCompany.evidenceIds, ...extracted.evidenceIds])] }, selectedCompany.id, selectedCompany.version);
        for (const contact of extraction.contacts) {
          if (!contact.telegramUserIds.length) continue; // no guessed merge on display name
          const existingIds = (await tx.query<{ contact_id: string }>('SELECT DISTINCT contact_id FROM contact_telegram_ids WHERE telegram_user_id=ANY($1::bigint[])', [contact.telegramUserIds])).rows;
          if (existingIds.length > 1) continue;
          const existing = existingIds[0] ? await getContactTx(tx, existingIds[0].contact_id) : null;
          const roles = contact.roles.filter((r) => [selectedCompany.canonicalName, ...selectedCompany.aliases].some((name) => name.toLowerCase() === r.companyName.toLowerCase())).map((r) => ({ companyId: selectedCompany.id, role: r.role, evidenceIds: r.evidenceIds }));
          const mergedRoles = [...(existing?.roles ?? []), ...roles].map((r) => ({ companyId: r.companyId, role: r.role, evidenceIds: r.evidenceIds }));
          const value = await writeContactTx(tx, { ...contact, idempotencyKey: jobId, telegramUserIds: [...new Set([...(existing?.telegramUserIds ?? []), ...contact.telegramUserIds])],
            names: [...new Set([...(existing?.names ?? []), ...contact.names])], usernames: [...new Set([...(existing?.usernames ?? []), ...contact.usernames])], phones: [...new Set([...(existing?.phones ?? []), ...contact.phones])], emails: [...new Set([...(existing?.emails ?? []), ...contact.emails])],
            affiliation: existing?.affiliation === 'internal' ? 'internal' : contact.affiliation, evidenceIds: [...new Set([...(existing?.evidenceIds ?? []), ...contact.evidenceIds])], roles: mergedRoles }, existing?.id, existing?.version);
          await tx.query('INSERT INTO ticket_contacts(ticket_id,contact_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [ticket.id, value.id]);
        }
        await tx.query('UPDATE facts SET ticket_id=$2 WHERE job_id=$1', [jobId, ticket.id]);
        await links(tx, 'ticket_evidence', 'ticket_id', ticket.id, evidenceIds, false);
        const latest = extraction.substantive ? input.messages.filter((m) => evidenceIds.some((id) => input.evidence.some((e) => e.id === id && e.messageId === m.id))).map((m) => m.sentAt).sort().at(-1) ?? null : null;
        await tx.query(`UPDATE tickets SET summary=$2,workstream=COALESCE($3,workstream),latest_substantive_at=GREATEST(latest_substantive_at,$4::timestamptz),updated_at=now() WHERE id=$1`, [ticket.id, extraction.summary, decision.workstream, latest]);
        await refreshInferredActions(tx, ticket.id);
        if (this.hooks.onDecision) await this.hooks.onDecision(tx, { jobId, ticketId: ticket.id, expectedStageVersion: input.ticket?.stageVersion ?? 0, decision });
      } else if (!manual) {
        await tx.query('DELETE FROM mapping_candidate_evidence WHERE candidate_id IN(SELECT id FROM mapping_candidates WHERE chat_id=$1)', [input.chat.id]);
        await tx.query('DELETE FROM mapping_candidates WHERE chat_id=$1', [input.chat.id]);
        for (const candidate of match.outcome === 'matched' ? [] : match.candidates) {
          await assertEvidence(tx, candidate.evidenceIds, input.chat.id);
          const row = (await tx.query<{ id: string }>('INSERT INTO mapping_candidates(chat_id,company_id,canonical_name,confidence,mapping_version) VALUES($1,$2,$3,$4,$5) RETURNING id', [input.chat.id, candidate.companyId, candidate.canonicalName, candidate.confidence, input.chat.mappingVersion])).rows[0]!;
          await links(tx, 'mapping_candidate_evidence', 'candidate_id', row.id, candidate.evidenceIds);
        }
      }
      // Proposal intent (when configured) and decision commit atomically; neither authorizes a move.
      await this.fenced(tx, jobId, claimToken);
      const updated = await tx.query(`UPDATE analysis_jobs SET decision=$2::jsonb,jev_provenance=$3::jsonb,jev_diagnostics=$4::jsonb,status='completed',lease_until=NULL,worker_id=NULL,last_error=NULL,updated_at=$5
        WHERE id=$1 AND worker_id=$6 AND status='running' AND lease_until>$5 RETURNING id`, [jobId, JSON.stringify(decision), JSON.stringify(provenance), JSON.stringify(decision.diagnostics), this.clock.now(), claimToken]);
      assert(updated.rows.length === 1, 'conflict', 'Analysis lease expired during completion');
    });
  }
  async fail(jobId: string, error: Extract<ProviderResult<never>, { ok: false }>, claimToken: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.fenced(tx, jobId, claimToken); await this.load(tx, jobId);
      const status = error.retryable ? 'retry' : 'provider_unavailable';
      // Whitelisted codes only; callers cannot persist raw provider exception strings.
      const code = ['unconfigured', 'entitlement', 'rate_limited', 'timeout', 'invalid_response', 'unavailable'].includes(error.code) ? error.code : 'unavailable';
      const retryAt = error.retryable ? error.retryAt ?? new Date(this.clock.now().getTime() + 60000).toISOString() : null;
      const updated = await tx.query(`UPDATE analysis_jobs SET status=$2,retry_at=$3,last_error=$4,lease_until=NULL,worker_id=NULL,updated_at=$5
        WHERE id=$1 AND worker_id=$6 AND status='running' AND lease_until>$5 RETURNING id`, [jobId, status, retryAt, `provider_${code}`, this.clock.now(), claimToken]);
      assert(updated.rows.length === 1, 'conflict', 'Analysis lease expired during failure handling');
    });
  }
  async replayUnavailable(input: { idempotencyKey: string; chatId?: string }): Promise<{ queued: number }> {
    return command(this.db, 'analysis:replay', input.idempotencyKey, input, async (tx) => {
      await this.hooks.onReplay?.(tx);
      // Changed mappings/policies are never revived under obsolete job snapshots.
      const result = await tx.query(`UPDATE analysis_jobs j SET status='pending',retry_at=NULL,last_error=NULL WHERE j.status='provider_unavailable'
        AND ($1::bigint IS NULL OR j.chat_id=$1) AND EXISTS(SELECT 1 FROM chats c WHERE c.id=j.chat_id AND c.inclusion='included' AND NOT c.is_control
        AND c.policy_version=j.policy_version AND c.mapping_version=j.mapping_version)
        AND NOT EXISTS(SELECT 1 FROM analysis_job_messages s LEFT JOIN messages m ON m.chat_id=s.chat_id AND m.id=s.message_id
          WHERE s.job_id=j.id AND (m.version IS NULL OR m.version<>s.message_version OR m.deleted_at IS NOT NULL)) RETURNING j.id`, [input.chatId ?? null]);
      return { queued: result.rows.length };
    });
  }
}
