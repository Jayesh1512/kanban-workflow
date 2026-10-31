import type { Mutation } from '../shared/domain.js';
import type { ProposalService } from '../shared/ports.js';
import { DomainError } from '../shared/api.js';
import { ProposalRepository, lockProposal, markStale, staleReason } from '../workflow/proposals.js';

/** Approval and lane state commit in one database transaction; no board replica. */
export class NativeProposalWorkflow implements ProposalService {
  constructor(readonly proposals: ProposalRepository) {}
  propose: ProposalService['propose'] = input => this.proposals.propose(input);
  get: ProposalService['get'] = id => this.proposals.get(id);
  list: ProposalService['list'] = input => this.proposals.list(input);
  decide: ProposalService['decide'] = input => this.proposals.decide(input);
  handleControlReply: ProposalService['handleControlReply'] = message => this.proposals.handleControlReply(message);
  async applyNext(signal?: AbortSignal): Promise<Mutation | null> {
    signal?.throwIfAborted();
    const ref = (await this.proposals.db.query(`SELECT id FROM proposals WHERE decision='approved'
      AND apply_state IN ('queued','applying','reconciling') ORDER BY updated_at,id LIMIT 1`)).rows[0];
    if (!ref) return null;
    await this.proposals.db.transaction(async tx => {
      const { proposal, ticket, chat } = await lockProposal(tx, String(ref.id));
      if (proposal.decision !== 'approved' || !['queued','applying','reconciling'].includes(proposal.applyState)) return;
      const stale = await staleReason(tx, proposal, ticket, chat);
      if (stale) { await markStale(tx, proposal.id, stale); return; }
      signal?.throwIfAborted();
      const updated = await tx.query(`UPDATE tickets SET previous_active_lane=CASE WHEN $2='Blocked'
        AND lane IN ('To be started','Work in progress','Integrations') THEN lane ELSE previous_active_lane END,
        lane=$2,stage_version=stage_version+1,updated_at=now()
        WHERE id=$1 AND stage_version=$3 AND lane=$4 RETURNING id`,
        [proposal.ticketId,proposal.targetLane,proposal.sourceStageVersion,proposal.sourceLane]);
      if (!updated.rowCount) throw new DomainError('conflict','Work stage changed; refresh the proposal');
      await tx.query("UPDATE proposals SET apply_state='applied',applied_at=now(),last_error=NULL,updated_at=now() WHERE id=$1",[proposal.id]);
      await tx.query("UPDATE proposals SET apply_state='stale',last_error='another_proposal_applied' WHERE ticket_id=$1 AND id<>$2 AND apply_state<>'applied'",[proposal.ticketId,proposal.id]);
    });
    return null;
  }
  async reconcile(_id: string): Promise<Mutation> {
    throw new DomainError('conflict','Historical remote mutations are retained for audit; native Work uses atomic database changes');
  }
}
