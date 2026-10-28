import { AsyncLocalStorage } from 'node:async_hooks';
import { crmFirstEnabled } from '../shared/crm-first.js';
import { randomUUID } from 'node:crypto';
import type { Lane, Mutation, Proposal } from '../shared/domain.js';
import type { Clock, Database, MutationStore, SqlExecutor } from '../shared/ports.js';
import { assert, nullableIso, type Row } from './sql.js';
import { getProposalTx, lockProposal, markStale, staleReason } from './proposals.js';

type Ownership = Readonly<{ ticketId: string; token: string; signal: AbortSignal }>;
const ownership = new AsyncLocalStorage<Ownership>();
export const ticketLockKey = (ticketId: string) => `antseed:ticket:${ticketId}`;
export function mutationRow(row: Row): Mutation { return { id: String(row.id), proposalId: String(row.proposal_id), taskId: String(row.task_id), sourceBucketId: String(row.source_bucket_id), targetBucketId: String(row.target_bucket_id),
  state: row.state as Mutation['state'], attempts: Number(row.attempts), leaseUntil: nullableIso(row.lease_until), lastError: row.last_error as string | null }; }

/** Local observation of an actual remote lane. It never sends a remote write. */
export async function observeRemoteTx(tx: SqlExecutor, ticketId: string, actualBucket: string): Promise<boolean> {
  // Serialize with operator exclusion/correction before taking any child locks.
  await tx.query('SELECT c.id FROM chats c JOIN tickets t ON t.chat_id=c.id WHERE t.id=$1 FOR UPDATE OF c', [ticketId]);
  await tx.query('SELECT id FROM tickets WHERE id=$1 FOR UPDATE', [ticketId]);
  const bucket = (await tx.query<{ lane: Lane }>('SELECT lane FROM board_buckets WHERE bucket_id=$1', [actualBucket])).rows[0]; if (!bucket) return false;
  if (await crmFirstEnabled(tx)) {
    const ticket = (await tx.query('SELECT lane FROM tickets WHERE id=$1', [ticketId])).rows[0];
    if (ticket?.lane === bucket.lane) return true;
    await tx.query(`INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,
      [`workflow:unapproved-movement:${ticketId}`, JSON.stringify({ observedLane: bucket.lane, acceptedLane: ticket?.lane, state: 'needs_telegram_approval' })]);
    return false;
  }
  await tx.query(`UPDATE tickets SET previous_active_lane=CASE WHEN $2='Blocked' AND lane IN ('To be started','Work in progress','Integrations') THEN lane ELSE previous_active_lane END,
    lane=$2,stage_version=stage_version+1,updated_at=now() WHERE id=$1 AND lane<>$2`, [ticketId, bucket.lane]);
  await tx.query("UPDATE proposals SET apply_state='stale',last_error='remote_stage_changed' WHERE ticket_id=$1 AND apply_state<>'applied'", [ticketId]);
  return true;
}

export class SqlMutationStore implements MutationStore {
  constructor(readonly db: Database, readonly clock: Clock = { now: () => new Date() }, readonly leaseMs = 120000) {}
  /** Only the service uses this entrypoint. The token is immutable across the entire async attempt. */
  async withOwnedTicket<T>(ticketId: string, work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    assert(!ownership.getStore(), 'conflict', 'Cannot replace an active mutation ownership scope');
    return this.db.withSessionLock(ticketLockKey(ticketId), async (_session, lockSignal) => {
      const scopedSignal = signal ? AbortSignal.any([signal, lockSignal]) : lockSignal;
      const captured = Object.freeze({ ticketId, token: randomUUID(), signal: scopedSignal }); scopedSignal.throwIfAborted();
      return ownership.run(captured, () => work(scopedSignal));
    });
  }
  private context(ticketId?: string): Ownership {
    const current = ownership.getStore(); assert(current && (!ticketId || current.ticketId === ticketId), 'conflict', 'Mutation write requires active matching ticket ownership');
    current.signal.throwIfAborted(); return current;
  }
  private async fenced(tx: SqlExecutor, id: string): Promise<Row> {
    const context = this.context();
    const ref = (await tx.query('SELECT proposal_id,ticket_id FROM mutations WHERE id=$1', [id])).rows[0];
    assert(ref && String(ref.ticket_id) === context.ticketId, 'conflict', 'Mutation does not match ticket ownership');
    // Every write path uses chat -> ticket -> proposal -> journal, including
    // observation from conflict/commit; no journal owner waits for a new chat lock.
    await lockProposal(tx, String(ref.proposal_id));
    const row = (await tx.query('SELECT * FROM mutations WHERE id=$1 FOR UPDATE', [id])).rows[0];
    assert(row && String(row.ticket_id) === context.ticketId && row.worker_id === context.token && ['prepared', 'remote_unknown', 'remote_confirmed'].includes(String(row.state)) && row.lease_until && new Date(row.lease_until as string).getTime() > this.clock.now().getTime(), 'conflict', 'Mutation claim expired or was replaced');
    this.context(context.ticketId); return row;
  }
  private finish(row: Row): void {
    const context = this.context(String(row.ticket_id));
    assert(row.worker_id === context.token && row.lease_until && new Date(row.lease_until as string).getTime() > this.clock.now().getTime(), 'conflict', 'Mutation lease expired during write');
  }
  async prepare(proposalId: string): Promise<Mutation> {
    const context = this.context();
    const result = await this.db.transaction(async (tx) => {
      const { proposal, ticket, chat } = await lockProposal(tx, proposalId); this.context(proposal.ticketId);
      const existing = (await tx.query('SELECT * FROM mutations WHERE proposal_id=$1 FOR UPDATE', [proposalId])).rows[0];
      if (existing?.state === 'committed') return { mutation: mutationRow(existing), stale: false };
      assert(proposal.decision === 'approved', 'conflict', 'Only approved proposals can prepare a mutation');
      assert(!existing || existing.state !== 'conflict', 'conflict', 'Conflicting mutation requires a new proposal');
      // Adoption is permitted only inside a newly acquired ticket session lock. Every
      // subsequent effect in this transaction uses this exact immutable attempt token.
      const lease = new Date(this.clock.now().getTime() + this.leaseMs);
      if (existing?.worker_id === context.token) this.finish(existing);
      const adopted = existing ? (await tx.query("UPDATE mutations SET worker_id=$2,lease_until=$3,attempts=attempts+1,updated_at=now() WHERE id=$1 AND worker_id IS NOT DISTINCT FROM $4 AND state IN ('prepared','remote_unknown','remote_confirmed') RETURNING *", [existing.id, context.token, lease, existing.worker_id])).rows[0]! : null;
      assert(!existing || adopted, 'conflict', 'Mutation adoption lost ownership');
      const stale = await staleReason(tx, proposal, ticket, chat);
      if (stale || proposal.applyState === 'stale') {
        await markStale(tx, proposal.id, stale ?? 'already_stale');
        if (adopted) {
          // Any prepared attempt may have crossed the remote acceptance boundary
          // before a crash. Source changes forbid new writes, never readback.
          this.finish(adopted); return { mutation: mutationRow(adopted), stale: false };
        }
        return { mutation: null, stale: true };
      }
      assert(ticket.vikunja_task_id, 'upstream_unavailable', 'Ticket must be projected before applying a proposal');
      const binding = (await tx.query('SELECT project_id,view_id FROM board_bindings WHERE singleton')).rows[0]; assert(binding, 'upstream_unavailable', 'Managed board is not bound');
      const buckets = (await tx.query<{ lane: Lane; bucket_id: string }>('SELECT lane,bucket_id::text FROM board_buckets WHERE lane=ANY($1::text[])', [[proposal.sourceLane, proposal.targetLane]])).rows;
      const source = buckets.find((b) => b.lane === proposal.sourceLane), target = buckets.find((b) => b.lane === proposal.targetLane); assert(source && target, 'upstream_unavailable', 'Proposal buckets are unavailable');
      // A fresh acquired session lock permits conservative adoption after process/session loss.
      const row = adopted ?? (await tx.query(`INSERT INTO mutations(proposal_id,ticket_id,task_id,project_id,view_id,source_bucket_id,target_bucket_id,worker_id,lease_until,attempts)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1) RETURNING *`, [proposalId, proposal.ticketId, ticket.vikunja_task_id, binding.project_id, binding.view_id, source.bucket_id, target.bucket_id, context.token, lease])).rows[0]!;
      await tx.query("UPDATE proposals SET apply_state=$2,last_error=NULL WHERE id=$1", [proposalId, row.state === 'prepared' ? 'applying' : 'reconciling']); this.finish(row);
      return { mutation: mutationRow(row), stale: false };
    });
    assert(!result.stale && result.mutation, 'stale_proposal', 'Proposal sources changed before remote apply'); return result.mutation;
  }
  async claim(input: { workerId: string; leaseMs: number }): Promise<Mutation | null> {
    const context = this.context(); assert(input.workerId.length > 0 && input.leaseMs > 0 && input.leaseMs <= 3600000, 'validation', 'Invalid mutation lease');
    return this.db.transaction(async (tx) => {
      const ref = (await tx.query("SELECT id FROM mutations WHERE ticket_id=$1 AND state IN ('prepared','remote_unknown','remote_confirmed') ORDER BY created_at,id LIMIT 1", [context.ticketId])).rows[0]; if (!ref) return null;
      const row = await this.fenced(tx, String(ref.id));
      // Never rotate ownership within an existing scope. prepare/adoption captures it once.
      assert(row.worker_id === context.token && new Date(row.lease_until as string).getTime() > this.clock.now().getTime(), 'conflict', 'Prepare mutation under this ownership before claiming');
      const updated = (await tx.query("UPDATE mutations SET lease_until=$2,updated_at=now() WHERE id=$1 AND worker_id=$3 AND state IN ('prepared','remote_unknown','remote_confirmed') AND lease_until>$4 RETURNING *", [row.id, new Date(this.clock.now().getTime() + input.leaseMs), context.token, this.clock.now()])).rows[0]!;
      assert(updated, 'conflict', 'Mutation lease expired'); this.finish(updated); return mutationRow(updated);
    });
  }
  async details(id: string): Promise<Row> { return this.db.transaction((tx) => this.fenced(tx, id)); }
  async validate(id: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const row = await this.fenced(tx, id); const { proposal, ticket, chat } = await lockProposal(tx, String(row.proposal_id));
      const stale = await staleReason(tx, proposal, ticket, chat);
      if (stale || proposal.applyState === 'stale') { await this.conflictTx(tx, row, stale ?? 'already_stale'); return false; }
      this.finish(row); return true;
    });
  }
  async markRemoteUnknown(id: string, _detail: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const row = await this.fenced(tx, id); const context = this.context();
      const updated = await tx.query("UPDATE mutations SET state='remote_unknown',last_error='remote_outcome_unknown',updated_at=now() WHERE id=$1 AND worker_id=$2 AND state IN ('prepared','remote_unknown','remote_confirmed') AND lease_until>$3 RETURNING id", [id, context.token, this.clock.now()]);
      assert(updated.rows.length === 1, 'conflict', 'Mutation lease expired');
      await tx.query("UPDATE proposals SET apply_state='reconciling',last_error='remote_outcome_unknown',updated_at=now() WHERE id=$1 AND apply_state<>'stale'", [row.proposal_id]); this.finish(row);
    });
  }
  async confirmRemote(id: string, actualBucketId: string): Promise<Mutation> {
    return this.db.transaction(async (tx) => {
      const row = await this.fenced(tx, id); assert(String(row.target_bucket_id) === actualBucketId, 'conflict', 'Remote target has not been observed'); const context = this.context();
      const updated = (await tx.query("UPDATE mutations SET state='remote_confirmed',last_error=NULL,updated_at=now() WHERE id=$1 AND worker_id=$2 AND state IN ('prepared','remote_unknown','remote_confirmed') AND lease_until>$3 RETURNING *", [id, context.token, this.clock.now()])).rows[0]!; assert(updated, 'conflict', 'Mutation claim expired'); this.finish(updated); return mutationRow(updated);
    });
  }
  private async conflictTx(tx: SqlExecutor, row: Row, code: string, actualBucketId?: string) {
    const context = this.context(String(row.ticket_id));
    if (actualBucketId) await observeRemoteTx(tx, context.ticketId, actualBucketId);
    const updated = await tx.query("UPDATE mutations SET state='conflict',lease_until=NULL,last_error=$2,updated_at=now() WHERE id=$1 AND worker_id=$3 AND state IN ('prepared','remote_unknown','remote_confirmed') AND lease_until>$4 RETURNING id", [row.id, code, context.token, this.clock.now()]);
    assert(updated.rows.length === 1, 'conflict', 'Mutation lease expired');
    await markStale(tx, String(row.proposal_id), code); this.finish(row);
  }
  async conflict(id: string, actualBucketId: string): Promise<Mutation> {
    return this.db.transaction(async (tx) => { const row = await this.fenced(tx, id); await this.conflictTx(tx, row, 'remote_stage_conflict', actualBucketId); return mutationRow({ ...row, state: 'conflict', lease_until: null, last_error: 'remote_stage_conflict' }); });
  }
  async commit(id: string): Promise<Proposal> {
    const context = this.context();
    return this.db.transaction(async (tx) => {
      const existing = (await tx.query('SELECT * FROM mutations WHERE id=$1', [id])).rows[0]; assert(existing && String(existing.ticket_id) === context.ticketId, 'not_found', 'Mutation not found');
      if (existing.state === 'committed') return getProposalTx(tx, String(existing.proposal_id));
      const row = await this.fenced(tx, id); assert(row.state === 'remote_confirmed', 'conflict', 'Remote target is not confirmed');
      const { proposal, ticket, chat } = await lockProposal(tx, String(row.proposal_id)); const stale = await staleReason(tx, proposal, ticket, chat);
      if (stale || proposal.applyState === 'stale') { await this.conflictTx(tx, row, 'remote_target_observed_sources_changed', String(row.target_bucket_id)); return getProposalTx(tx, proposal.id); }
      assert(proposal.decision === 'approved', 'conflict', 'Proposal approval is missing');
      const update = await tx.query(`UPDATE tickets SET previous_active_lane=CASE WHEN $2='Blocked' AND lane IN ('To be started','Work in progress','Integrations') THEN lane ELSE previous_active_lane END,
        lane=$2,stage_version=stage_version+1,updated_at=now() WHERE id=$1 AND stage_version=$3 AND lane=$4 RETURNING id`, [proposal.ticketId, proposal.targetLane, proposal.sourceStageVersion, proposal.sourceLane]);
      assert(update.rows.length === 1, 'conflict', 'Ticket stage changed before local commit');
      await tx.query("UPDATE proposals SET apply_state='applied',applied_at=$2,last_error=NULL,updated_at=$2 WHERE id=$1", [proposal.id, this.clock.now()]);
      const committed = await tx.query("UPDATE mutations SET state='committed',lease_until=NULL,last_error=NULL,updated_at=now() WHERE id=$1 AND worker_id=$2 AND state='remote_confirmed' AND lease_until>$3 RETURNING id", [id, context.token, this.clock.now()]);
      assert(committed.rows.length === 1, 'conflict', 'Mutation lease expired');
      await tx.query("UPDATE proposals SET apply_state='stale',last_error='another_proposal_applied' WHERE ticket_id=$1 AND id<>$2 AND apply_state<>'applied'", [proposal.ticketId, proposal.id]);
      const result = await getProposalTx(tx, proposal.id); this.finish(row); return result;
    });
  }
}
