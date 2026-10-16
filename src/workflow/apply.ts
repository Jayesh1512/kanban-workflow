import type { Mutation } from '../shared/domain.js';
import type { ProposalService, VikunjaPort } from '../shared/ports.js';
import { DomainError } from '../shared/api.js';
import { assert } from './sql.js';
import { ProposalRepository } from './proposals.js';
import { SqlMutationStore, mutationRow } from './mutations.js';
import { TicketProjector } from './projection.js';

/** Only this service's applyNext/reconcile paths perform remote stage writes. */
export class ProposalWorkflow implements ProposalService {
  constructor(readonly proposals: ProposalRepository, readonly mutations: SqlMutationStore, readonly vikunja: VikunjaPort, readonly projector: TicketProjector) {}
  propose: ProposalService['propose'] = (input) => this.proposals.propose(input);
  get: ProposalService['get'] = (id) => this.proposals.get(id);
  list: ProposalService['list'] = (input) => this.proposals.list(input);
  decide: ProposalService['decide'] = (input) => this.proposals.decide(input);
  handleControlReply: ProposalService['handleControlReply'] = (message) => this.proposals.handleControlReply(message);
  async applyNext(signal?: AbortSignal): Promise<Mutation | null> {
    const row = (await this.proposals.db.query<{ id: string; ticket_id: string }>(`SELECT p.id,p.ticket_id FROM proposals p LEFT JOIN mutations m ON m.proposal_id=p.id
      WHERE p.decision='approved' AND ((m.id IS NULL AND p.apply_state='queued') OR (m.state IN ('prepared','remote_unknown','remote_confirmed') AND p.apply_state IN ('queued','applying','reconciling','stale')))
      ORDER BY COALESCE(m.updated_at,p.updated_at),p.id LIMIT 1`)).rows[0];
    if (!row) return null;
    try { return await this.run(row.id, row.ticket_id, signal); }
    catch (error) {
      signal?.throwIfAborted();
      // Only refresh scheduling metadata under a NEW healthy lock. The journal
      // remains untouched until fresh ownership and conservative readback.
      await this.proposals.db.withSessionLock(`antseed:ticket:${row.ticket_id}`, async () => {
        await this.proposals.db.query("UPDATE proposals SET last_error='apply_retry_required',updated_at=now() WHERE id=$1 AND decision='approved' AND apply_state IN ('queued','applying','reconciling')", [row.id]);
      });
      throw error;
    }
  }
  private async run(proposalId: string, ticketId: string, signal?: AbortSignal): Promise<Mutation | null> {
    return this.mutations.withOwnedTicket(ticketId, async (scoped) => {
      const existing = (await this.proposals.db.query('SELECT id,state FROM mutations WHERE proposal_id=$1', [proposalId])).rows[0];
      const currentProposal = await this.get(proposalId);
      if (currentProposal.applyState === 'applied' || (currentProposal.applyState === 'stale' && !existing) || currentProposal.decision !== 'approved') {
        return existing ? mutationRow((await this.proposals.db.query('SELECT * FROM mutations WHERE id=$1', [existing.id])).rows[0]!) : null;
      }
      if (!existing) await this.projector.project(ticketId, scoped);
      let mutation: Mutation;
      try { mutation = await this.mutations.prepare(proposalId); }
      catch (error) { if (error instanceof DomainError && error.code === 'stale_proposal') return null; throw error; }
      if (mutation.state === 'committed') return mutation;
      const details = await this.mutations.details(mutation.id); scoped.throwIfAborted();
      let remote;
      try { remote = await this.vikunja.getTask(mutation.taskId); }
      catch { scoped.throwIfAborted(); await this.mutations.markRemoteUnknown(mutation.id, 'read_failed'); return mutationRow(await this.mutations.details(mutation.id)); }
      scoped.throwIfAborted();
      if (!remote || remote.projectId !== String(details.project_id)) {
        await this.mutations.markRemoteUnknown(mutation.id, 'remote_missing_or_moved'); return mutationRow(await this.mutations.details(mutation.id));
      }
      if (remote.bucketId !== mutation.sourceBucketId && remote.bucketId !== mutation.targetBucketId) return this.mutations.conflict(mutation.id, remote.bucketId);
      if (remote.bucketId === mutation.sourceBucketId && mutation.state === 'remote_confirmed') return this.mutations.conflict(mutation.id, remote.bucketId);
      if (remote.bucketId === mutation.sourceBucketId) {
        if (!await this.mutations.validate(mutation.id)) return mutationRow((await this.proposals.db.query('SELECT * FROM mutations WHERE id=$1', [mutation.id])).rows[0]!);
        scoped.throwIfAborted();
        try {
          await this.vikunja.moveTask({ taskId: mutation.taskId, projectId: String(details.project_id), viewId: String(details.view_id), targetBucketId: mutation.targetBucketId });
          scoped.throwIfAborted(); remote = await this.vikunja.getTask(mutation.taskId); scoped.throwIfAborted();
        } catch { scoped.throwIfAborted(); await this.mutations.markRemoteUnknown(mutation.id, 'move_unknown'); return mutationRow(await this.mutations.details(mutation.id)); }
        if (!remote || remote.bucketId === mutation.sourceBucketId) { await this.mutations.markRemoteUnknown(mutation.id, 'target_not_confirmed'); return mutationRow(await this.mutations.details(mutation.id)); }
        if (remote.bucketId !== mutation.targetBucketId) return this.mutations.conflict(mutation.id, remote.bucketId);
      }
      assert(remote.bucketId === mutation.targetBucketId, 'conflict', 'Remote target not observed');
      await this.mutations.confirmRemote(mutation.id, remote.bucketId); scoped.throwIfAborted();
      await this.mutations.commit(mutation.id); scoped.throwIfAborted();
      return mutationRow((await this.proposals.db.query('SELECT * FROM mutations WHERE id=$1', [mutation.id])).rows[0]!);
    }, signal);
  }
  async reconcile(mutationId: string): Promise<Mutation> {
    const row = (await this.proposals.db.query('SELECT * FROM mutations WHERE id=$1', [mutationId])).rows[0]; assert(row, 'not_found', 'Mutation not found');
    if (row.state === 'committed' || row.state === 'conflict') return mutationRow(row);
    const result = await this.run(String(row.proposal_id), String(row.ticket_id)); assert(result, 'conflict', 'Mutation is stale'); return result;
  }
}
