import { automaticPolicy } from '../shared/automatic-policy.js';
import type { JevDecision, Lane, Proposal } from '../shared/domain.js';
import { LANES } from '../shared/domain.js';
import type { Clock, ControlBus, ControlMessage, Database, SqlExecutor } from '../shared/ports.js';
import type { DecideProposalInput, ProposeLaneInput } from '../shared/schemas.js';
import { decideProposalSchema, proposeLaneSchema, uuidSchema } from '../shared/schemas.js';
import { DomainError } from '../shared/api.js';
import { currentTicketMapping } from '../shared/ticket-mapping.js';
import { assert, assertEvidence, command, iso, links, nullableIso, page, type Row } from './sql.js';

export async function proposalRow(tx: SqlExecutor, row: Row): Promise<Proposal> {
  return { id: String(row.id), ticketId: String(row.ticket_id), sourceLane: row.source_lane as Lane, sourceStageVersion: Number(row.source_stage_version),
    sourceMappingVersion: Number(row.source_mapping_version), sourcePolicyVersion: Number(row.source_policy_version), targetLane: row.target_lane as Lane,
    evidenceIds: (await tx.query<{ evidence_id: string }>('SELECT evidence_id FROM proposal_evidence WHERE proposal_id=$1 ORDER BY evidence_id', [row.id])).rows.map((r) => r.evidence_id),
    reason: String(row.reason), nextAction: row.next_action as string | null, origin: row.origin as Proposal['origin'], decision: row.decision as Proposal['decision'], applyState: row.apply_state as Proposal['applyState'],
    correctionOf: row.correction_of as string | null, decidedAt: nullableIso(row.decided_at), appliedAt: nullableIso(row.applied_at), lastError: row.last_error as string | null };
}
export async function getProposalTx(tx: SqlExecutor, id: string): Promise<Proposal> {
  const row = (await tx.query('SELECT * FROM proposals WHERE id=$1', [id])).rows[0]; assert(row, 'not_found', 'Proposal not found'); return proposalRow(tx, row);
}
export async function lockProposal(tx: SqlExecutor, id: string): Promise<{ proposal: Proposal; ticket: Row; chat: Row }> {
  const chat = (await tx.query('SELECT c.* FROM chats c JOIN tickets t ON t.chat_id=c.id JOIN proposals p ON p.ticket_id=t.id WHERE p.id=$1 FOR UPDATE OF c', [id])).rows[0];
  assert(chat, 'not_found', 'Proposal not found');
  const ticket = (await tx.query('SELECT t.* FROM tickets t JOIN proposals p ON p.ticket_id=t.id WHERE p.id=$1 FOR UPDATE OF t', [id])).rows[0]!;
  const row = (await tx.query('SELECT * FROM proposals WHERE id=$1 FOR UPDATE', [id])).rows[0]!;
  return { proposal: await proposalRow(tx, row), ticket, chat };
}
export async function staleReason(tx: SqlExecutor, proposal: Proposal, ticket: Row, chat: Row): Promise<string | null> {
  if (!proposal.evidenceIds.length) return 'evidence_missing';
  if (chat.inclusion !== 'included' || chat.is_control || ticket.tracking_state !== 'active') return 'chat_not_tracked';
  if (!currentTicketMapping({ mappingStatus: chat.mapping_status as 'confirmed' | 'unresolved' | 'ambiguous' | 'non_company', companyId: chat.company_id as string | null }, { kind: ticket.kind === 'contact_prospect' ? 'contact_prospect' : 'company', companyId: ticket.company_id as string | null }) || Number(chat.mapping_version) !== proposal.sourceMappingVersion) return 'mapping_changed';
  if (Number(chat.policy_version) !== proposal.sourcePolicyVersion) return 'policy_changed';
  if (Number(ticket.stage_version) !== proposal.sourceStageVersion || ticket.lane !== proposal.sourceLane) return 'stage_changed';
  try { await assertEvidence(tx, proposal.evidenceIds, String(chat.id)); } catch (error) { if (error instanceof DomainError) return 'evidence_changed'; throw error; }
  return null;
}
export async function markStale(tx: SqlExecutor, proposalId: string, reason: string): Promise<void> {
  await tx.query("UPDATE proposals SET apply_state='stale',last_error=$2,updated_at=now() WHERE id=$1 AND apply_state<>'applied'", [proposalId, reason]);
}
export function controlProposalText(proposal: Proposal): string {
  return `Stage proposal ${proposal.id}\n${proposal.sourceLane} → ${proposal.targetLane}\n${proposal.reason.slice(0, 6000)}\nNext action: ${proposal.nextAction ?? 'Unspecified'}\nEvidence: ${proposal.evidenceIds.join(', ')}\nReply approve, reject, or correct <lane> | <reason>.`;
}

/** SQL-only service; remote application is attached by the apply service in M3.2. */
export class ProposalRepository {
  constructor(readonly db: Database, readonly control: ControlBus, readonly clock: Clock = { now: () => new Date() }) {}
  async get(id: string): Promise<Proposal> { uuidSchema.parse(id); return getProposalTx(this.db, id); }
  async list(input: { cursor?: string; limit?: number; ticketId?: string; decision?: Proposal['decision'] }) {
    const p = page(input); const rows = (await this.db.query(`SELECT * FROM proposals WHERE ($1::uuid IS NULL OR id>$1) AND ($2::uuid IS NULL OR ticket_id=$2) AND ($3::text IS NULL OR decision=$3) ORDER BY id LIMIT $4`, [p.after, input.ticketId ?? null, input.decision ?? null, p.limit + 1])).rows;
    return { items: await Promise.all(rows.slice(0, p.limit).map((r) => proposalRow(this.db, r))), nextCursor: rows.length > p.limit ? String(rows[p.limit - 1]!.id) : null };
  }
  async initialPlacementPending(tx: SqlExecutor, ticketId: string): Promise<boolean> {
    const policy=await automaticPolicy(tx);if(!policy?.initialPlacement)return false;
    return Boolean((await tx.query(`SELECT 1 FROM telegram_conversation_starts s JOIN tickets t ON t.chat_id=s.chat_id
      JOIN chats c ON c.id=t.chat_id WHERE t.id=$1 AND t.stage_version=0 AND s.state='qualifies'
      AND s.checked_cutoff=$2 AND s.first_message_at >= $2 AND s.initial_placement_at IS NULL
      AND c.inclusion='included' AND NOT c.is_control`,[ticketId,policy.cutoff])).rowCount);
  }
  private async deferInitialReview(tx:SqlExecutor,ticketId:string):Promise<boolean>{
    const policy=await automaticPolicy(tx);if(!policy?.initialPlacement)return false;
    return Boolean((await tx.query(`SELECT 1 FROM telegram_conversation_starts s JOIN tickets t ON t.chat_id=s.chat_id
      WHERE t.id=$1 AND t.stage_version=0 AND (s.checked_cutoff IS DISTINCT FROM $2::timestamptz OR s.state IN ('pending','checking','error'))`,[ticketId,policy.cutoff])).rowCount);
  }
  async enqueueTx(tx: SqlExecutor, proposal: Proposal): Promise<void> {
    if((proposal.origin==='openai'||proposal.origin==='jev')&&(await this.initialPlacementPending(tx,proposal.ticketId)||await this.deferInitialReview(tx,proposal.ticketId))) {
      await tx.query("UPDATE proposals SET last_error='initial_placement_pending' WHERE id=$1 AND decision='pending'",[proposal.id]);return;
    }
    const control = (await tx.query('SELECT id FROM chats WHERE is_control AND inclusion=\'excluded\'')).rows[0];
    if (!control) { await tx.query("UPDATE proposals SET last_error='control_chat_missing' WHERE id=$1 AND decision='pending'", [proposal.id]); return; }
    await this.control.enqueueProposal(tx, { proposalId: proposal.id, chatId: String(control.id), text: controlProposalText(proposal) });
    await tx.query("UPDATE proposals SET last_error=NULL WHERE id=$1 AND last_error='control_chat_missing'", [proposal.id]);
  }
  async proposeTx(tx: SqlExecutor, input: ProposeLaneInput, correctionOf: string | null = null): Promise<Proposal> {
    const chat = (await tx.query('SELECT c.* FROM chats c JOIN tickets t ON t.chat_id=c.id WHERE t.id=$1 FOR UPDATE OF c', [input.ticketId])).rows[0]; assert(chat, 'not_found', 'Ticket not found');
    const ticket = (await tx.query('SELECT * FROM tickets WHERE id=$1 FOR UPDATE', [input.ticketId])).rows[0]!;
    assert(chat.inclusion === 'included' && !chat.is_control && ticket.tracking_state === 'active', 'excluded_chat', 'Ticket is not tracked business content');
    assert(currentTicketMapping({ mappingStatus: chat.mapping_status as 'confirmed' | 'unresolved' | 'ambiguous' | 'non_company', companyId: chat.company_id as string | null }, { kind: ticket.kind === 'contact_prospect' ? 'contact_prospect' : 'company', companyId: ticket.company_id as string | null }), 'ambiguous_mapping', 'Ticket relationship mapping changed');
    assert(Number(ticket.stage_version) === input.expectedStageVersion, 'stale_proposal', 'Source stage version changed');
    assert(ticket.lane !== input.targetLane, 'validation', 'Target lane equals current lane'); await assertEvidence(tx, input.evidenceIds, String(chat.id));
    const row = (await tx.query(`INSERT INTO proposals(ticket_id,source_lane,source_stage_version,source_mapping_version,source_policy_version,target_lane,reason,next_action,origin,correction_of)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [input.ticketId, ticket.lane, input.expectedStageVersion, chat.mapping_version, chat.policy_version, input.targetLane, input.reason, input.nextAction, input.origin, correctionOf])).rows[0]!;
    await links(tx, 'proposal_evidence', 'proposal_id', String(row.id), input.evidenceIds);
    const proposal = await proposalRow(tx, row); await this.enqueueTx(tx, proposal); return getProposalTx(tx, proposal.id);
  }
  async propose(raw: ProposeLaneInput): Promise<Proposal> {
    const input = proposeLaneSchema.parse(raw); return command(this.db, 'proposal:create', input.idempotencyKey, input, (tx) => this.proposeTx(tx, input));
  }
  async recordAnalysisDecisionTx(tx: SqlExecutor, input: { jobId: string; ticketId: string; expectedStageVersion: number; decision: JevDecision }): Promise<void> {
    if (input.decision.lane.outcome !== 'propose') {
      if(await this.initialPlacementPending(tx,input.ticketId)) await tx.query(`UPDATE telegram_conversation_starts
        SET initial_placement_at=now(),initial_result=$2 WHERE chat_id=(SELECT chat_id FROM tickets WHERE id=$1) AND initial_placement_at IS NULL`,[input.ticketId,input.decision.lane.outcome]);
      return;
    }
    const key = `workflow:decision-proposal:${input.jobId}`;
    const policy=await automaticPolicy(tx);
    if(policy?.initialPlacement){
      const initial=(await tx.query(`SELECT s.initial_placement_at FROM telegram_conversation_starts s JOIN tickets t ON t.chat_id=s.chat_id
        WHERE t.id=$1 AND s.state='qualifies' AND s.checked_cutoff=$2 AND s.initial_placement_at IS NOT NULL`,[input.ticketId,policy.cutoff])).rows[0];
      if(initial && !(await tx.query(`SELECT 1 FROM evidence e JOIN messages m ON (m.chat_id,m.id)=(e.chat_id,e.message_id)
        WHERE e.id=ANY($1::uuid[]) AND GREATEST(m.sent_at,m.edited_at)>$2::timestamptz LIMIT 1`,[input.decision.lane.evidenceIds,initial['initial_placement_at']])).rowCount){
        await tx.query("INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING",[key,JSON.stringify({state:'initial_snapshot_reviewed',reason:'Historical initial-snapshot recommendations do not request approval again'})]);return;
      }
    }
    if ((await tx.query('SELECT 1 FROM app_settings WHERE key=$1', [key])).rows.length) return;
    const lane = input.decision.lane;
    const proposal = await this.proposeTx(tx, { idempotencyKey: `analysis:${input.jobId}`, ticketId: input.ticketId, expectedStageVersion: input.expectedStageVersion,
      targetLane: lane.targetLane, evidenceIds: lane.evidenceIds, reason: lane.reason, nextAction: lane.nextAction, origin: input.decision.diagnostics.rubricVersion.startsWith('openai.decisions.antseed.') ? 'openai' : 'jev' });
    await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb)', [key, JSON.stringify({ proposalId: proposal.id })]);
  }
  async recoverDecisionIntents(limit = 10): Promise<void> {
    const rows = (await this.db.query<{ id: string; ticket_id: string }>(`SELECT j.id,t.id AS ticket_id FROM analysis_jobs j JOIN tickets t ON t.chat_id=j.chat_id
      WHERE j.status='completed' AND j.decision->'lane'->>'outcome'='propose' AND NOT EXISTS(SELECT 1 FROM app_settings s WHERE s.key='workflow:decision-proposal:'||j.id::text)
      ORDER BY j.created_at,j.id LIMIT $1`, [limit])).rows;
    for (const row of rows) await this.db.transaction(async (tx) => {
      const job = (await tx.query('SELECT j.*,t.stage_version,c.policy_version AS current_policy,c.mapping_version AS current_mapping FROM analysis_jobs j JOIN tickets t ON t.chat_id=j.chat_id JOIN chats c ON c.id=j.chat_id WHERE j.id=$1 FOR UPDATE OF c,j', [row.id])).rows[0]!;
      const key = `workflow:decision-proposal:${row.id}`;
      if ((await tx.query('SELECT 1 FROM app_settings WHERE key=$1', [key])).rows.length) return;
      const history = (await tx.query('SELECT source FROM mapping_history WHERE chat_id=$1 AND version=$2', [job.chat_id, job.current_mapping])).rows[0];
      const changedMappingIsOwnAnalysis = Number(job.current_mapping) === Number(job.mapping_version) + 1 && history?.source === 'analysis';
      if ((Number(job.current_mapping) !== Number(job.mapping_version) && !changedMappingIsOwnAnalysis) || Number(job.stage_version) !== 0 || job.policy_version !== job.current_policy || Number(job.current_mapping) > Number(job.mapping_version) + 1) {
        await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb)', [key, JSON.stringify({ state: 'stale', code: 'analysis_context_changed' })]); return;
      }
      try { await this.recordAnalysisDecisionTx(tx, { jobId: row.id, ticketId: row.ticket_id, expectedStageVersion: 0, decision: job.decision as JevDecision }); }
      catch (error) {
        if (!(error instanceof DomainError) || !['validation', 'conflict', 'stale_proposal', 'excluded_chat', 'ambiguous_mapping'].includes(error.code)) throw error;
        await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb)', [key, JSON.stringify({ state: 'stale', code: error.code })]);
      }
    });
  }
  async decideTx(tx: SqlExecutor, input: DecideProposalInput, audit: { source: 'http' | 'telegram' | 'automation'; message?: ControlMessage }) {
    const { proposal, ticket, chat } = await lockProposal(tx, input.proposalId);
    assert(proposal.decision === 'pending', 'conflict', 'Proposal already has a decision');
    const stale = await staleReason(tx, proposal, ticket, chat);
    if (stale || proposal.applyState === 'stale') { await markStale(tx, proposal.id, stale ?? 'already_stale'); return { proposal: await getProposalTx(tx, proposal.id), replacement: null, stale: true }; }
    let replacement: Proposal | null = null;
    if (input.decision === 'correct') {
      replacement = await this.proposeTx(tx, { idempotencyKey: input.idempotencyKey, ticketId: proposal.ticketId, expectedStageVersion: proposal.sourceStageVersion,
        targetLane: input.targetLane, reason: input.reason, nextAction: proposal.nextAction, evidenceIds: input.evidenceIds, origin: 'manual' }, proposal.id);
    }
    const decision = input.decision === 'approve' ? 'approved' : input.decision === 'reject' ? 'rejected' : 'corrected';
    await tx.query(`UPDATE proposals SET decision=$2,decided_at=$3,apply_state=$4,last_error=NULL,updated_at=$3 WHERE id=$1`, [proposal.id, decision, this.clock.now(), input.decision === 'approve' ? 'queued' : 'not_requested']);
    await tx.query(`INSERT INTO proposal_decisions(proposal_id,idempotency_key,decision,source,control_chat_id,control_message_id,sender_id,note)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [proposal.id, input.idempotencyKey, input.decision, audit.source, audit.message?.chatId ?? null, audit.message?.messageId ?? null, audit.message?.senderId ?? null, input.decision === 'correct' ? input.reason : input.note ?? null]);
    return { proposal: await getProposalTx(tx, proposal.id), replacement, stale: false };
  }
  async decide(raw: DecideProposalInput): Promise<{ proposal: Proposal; replacement: Proposal | null }> {
    const input = decideProposalSchema.parse(raw);
    const result = await command(this.db, `proposal:decision:${input.proposalId}`, input.idempotencyKey, input, (tx) => this.decideTx(tx, input, { source: 'http' }));
    assert(!result.stale, 'stale_proposal', 'Proposal sources changed; create a new proposal'); return { proposal: result.proposal, replacement: result.replacement };
  }
  /** User-authorized initial placement only, through the ordinary approval/apply
   * journal. Later movement remains a Telegram/operator decision. */
  async placeInitialAutomatically(limit=5): Promise<number> {
    const policy=await automaticPolicy(this.db);if(!policy?.initialPlacement)return 0;
    const rows=(await this.db.query<{id:string;ticket_id:string}>(`SELECT p.id,p.ticket_id FROM proposals p JOIN tickets t ON t.id=p.ticket_id
      JOIN telegram_conversation_starts s ON s.chat_id=t.chat_id
      WHERE p.decision='pending' AND p.apply_state='not_requested' AND p.origin IN ('openai','jev')
      AND t.stage_version=0 AND s.state='qualifies' AND s.checked_cutoff=$1 AND s.first_message_at >= $1 AND s.initial_placement_at IS NULL
      AND EXISTS(SELECT 1 FROM app_settings a JOIN analysis_jobs j ON a.key='workflow:decision-proposal:'||j.id::text
        WHERE a.value->>'proposalId'=p.id::text AND j.status='completed' AND j.chat_id=t.chat_id)
      ORDER BY p.created_at,p.id LIMIT $2`,[policy.cutoff,limit])).rows;
    let count=0;
    for(const row of rows) await this.db.transaction(async tx=>{
      // Resolve in the established chat -> ticket -> proposal order.
      const {proposal}=await lockProposal(tx,row.id);
      const current=await automaticPolicy(tx);
      if(!current||current.revision!==policy.revision||!await this.initialPlacementPending(tx,row.ticket_id)||proposal.decision!=='pending')return;
      const result=await this.decideTx(tx,{idempotencyKey:`initial:${policy.revision}:${row.id}`,proposalId:row.id,decision:'approve',note:`Explicit user policy: initial placement for conversations first started since ${policy.cutoff}; revision ${policy.revision}. Later movements still require approval.`},{source:'automation'});
      if(result.stale)return;
      await tx.query(`UPDATE telegram_conversation_starts SET initial_placement_at=now(),initial_result='propose',initial_proposal_id=$2
        WHERE chat_id=(SELECT chat_id FROM tickets WHERE id=$1) AND initial_placement_at IS NULL`,[row.ticket_id,row.id]);count++;
    });
    return count;
  }
  async flushPendingControl(limit = 50): Promise<number> {
    const rows = (await this.db.query<{ id: string }>(`SELECT p.id FROM proposals p WHERE p.decision='pending' AND p.apply_state='not_requested'
      AND NOT EXISTS(SELECT 1 FROM control_outbox o JOIN chats c ON c.id=o.chat_id WHERE o.proposal_id=p.id AND c.is_control) ORDER BY p.created_at,p.id LIMIT $1`, [limit])).rows;
    let count = 0;
    for (const row of rows) await this.db.transaction(async (tx) => {
      const { proposal, ticket, chat } = await lockProposal(tx, row.id); if (proposal.decision !== 'pending') return;
      const stale = await staleReason(tx, proposal, ticket, chat); if (stale) { await markStale(tx, row.id, stale); return; }
      await this.enqueueTx(tx, proposal); count++;
    });
    return count;
  }
  async handleControlReply(message: ControlMessage): Promise<void> {
    if (!message.replyToMessageId || !/^(approve|reject|correct)\b/i.test(message.text.trim())) return;
    const control = (await this.db.query('SELECT id FROM chats WHERE id=$1 AND is_control', [message.chatId])).rows[0]; if (!control) return;
    const outbox = (await this.db.query<{ proposal_id: string }>('SELECT proposal_id FROM control_outbox WHERE chat_id=$1 AND message_id=$2', [message.chatId, message.replyToMessageId])).rows[0];
    if (!outbox) {
      const unknown = (await this.db.query("SELECT 1 FROM control_outbox WHERE chat_id=$1 AND message_id IS NULL AND attempts>0 AND state IN ('sending','failed') LIMIT 1", [message.chatId])).rows.length > 0;
      // A received reply can precede lost-send receipt reconciliation. Keep it
      // replayable until the attempted delivery's message linkage is known.
      if (unknown) throw new DomainError('upstream_unavailable', 'Proposal delivery receipt remains unknown; retain reply for replay', true);
      return;
    }
    const commandId = `telegram:${message.chatId}:${message.messageId}`;
    try {
      const text = message.text.trim(); const match = /^(approve|reject|correct)\b\s*([\s\S]*)$/i.exec(text)!; const action = match[1]!.toLowerCase();
      let input: DecideProposalInput;
      if (action === 'correct') {
        const [label, ...reason] = match[2]!.split('|'); const target = LANES.find((lane) => lane.toLowerCase() === label!.trim().toLowerCase()); assert(target, 'validation', 'Unknown correction lane');
        const proposal = await this.get(outbox.proposal_id);
        input = { idempotencyKey: commandId, proposalId: proposal.id, decision: 'correct', targetLane: target, reason: reason.join('|').trim().slice(0, 4000) || 'Corrected through control reply', evidenceIds: proposal.evidenceIds };
      } else input = { idempotencyKey: commandId, proposalId: outbox.proposal_id, decision: action as 'approve' | 'reject', note: match[2]!.slice(0, 4000) };
      await command(this.db, 'control:reply', commandId, input, (tx) => this.decideTx(tx, input, { source: 'telegram', message }));
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      // Invalid/stale/conflicting replies are terminal operational outcomes; no endless inbox retry.
      await this.db.query(`INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,
        [`workflow:control:${message.chatId}:${message.messageId}`, JSON.stringify({ proposalId: outbox.proposal_id, code: error.code, handledAt: iso(this.clock.now()) })]);
    }
  }
}
