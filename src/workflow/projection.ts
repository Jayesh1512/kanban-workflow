import { formatCard } from './card-format.js';
import { loadCardContext } from './card-context.js';
import { resolveTitleCompany } from './title-company.js';
import type { Ticket } from '../shared/domain.js';
import type { Clock, Database, VikunjaPort } from '../shared/ports.js';
import { DomainError } from '../shared/api.js';
import { currentTicketMapping } from '../shared/ticket-mapping.js';
import { assert, hash } from './sql.js';
import { RecordsRepository } from './records.js';
import { observeRemoteTx, ticketLockKey } from './mutations.js';

export class TicketProjector {
  constructor(readonly db: Database, readonly vikunja: VikunjaPort, readonly records: RecordsRepository, readonly clock: Clock = { now: () => new Date() }) {}
  async project(ticketId: string, signal?: AbortSignal): Promise<Ticket | null> {
    return this.db.withSessionLock(ticketLockKey(ticketId), async (_session, lockSignal) => {
      const scoped = signal ? AbortSignal.any([signal, lockSignal]) : lockSignal; scoped.throwIfAborted();
      const active = (await this.db.query("SELECT 1 FROM mutations WHERE ticket_id=$1 AND state IN ('prepared','remote_unknown','remote_confirmed')", [ticketId])).rows.length > 0;
      if (active) return null;
      const source = (await this.db.query('SELECT chat_id FROM tickets WHERE id=$1', [ticketId])).rows[0];
      if (source) await this.db.transaction(tx => resolveTitleCompany(tx, String(source['chat_id'])));
      const context = await loadCardContext(this.records, ticketId);
      const { ticket, chat } = context;
      assert(currentTicketMapping(chat, ticket), 'ambiguous_mapping', 'Projection requires the current company or contact-prospect mapping');
      let { title, description } = formatCard(context);
      const stateKey = `workflow:projection:${ticketId}`;
      const saved = (await this.db.query<{ value: { hash?: string; state?: string } }>('SELECT value FROM app_settings WHERE key=$1', [stateKey])).rows[0]?.value;
      // All upstream calls occur under a session lock, with no transaction open.
      let remote = ticket.vikunjaTaskId ? await this.vikunja.getTask(ticket.vikunjaTaskId) : await this.vikunja.ensureTask({ ticketId, title, description, workstream: ticket.workstream });
      scoped.throwIfAborted(); assert(remote, 'conflict', 'Previously projected task is missing');
      const binding = (await this.db.query('SELECT project_id FROM board_bindings WHERE singleton')).rows[0]; assert(binding && String(binding.project_id) === remote.projectId, 'conflict', 'Remote task left the managed project');
      const bucket = (await this.db.query<{ lane: string }>('SELECT lane FROM board_buckets WHERE bucket_id=$1', [remote.bucketId])).rows[0]; assert(bucket, 'conflict', 'Remote task left the managed buckets');
      if (bucket.lane !== ticket.lane) {
        await this.db.transaction((tx) => observeRemoteTx(tx, ticketId, remote!.bucketId));
        ({ title, description } = formatCard({ ...context, ticket: await this.records.getTicket(ticketId) }));
      }
      const signature = hash({ title, description, workstream: ticket.workstream, policy: chat.policyVersion, mapping: chat.mappingVersion });
      const justEnsuredCurrentDetails = !ticket.vikunjaTaskId && remote.title === title && (remote.description === description || remote.description === `${description}\n\n[antseed-ticket:${ticketId}]`);
      if (!justEnsuredCurrentDetails && (saved?.hash !== signature || saved.state !== 'ready')) {
        remote = await this.vikunja.updateTaskDetails({ taskId: remote.id, title, description, workstream: ticket.workstream }); scoped.throwIfAborted();
      }
      await this.db.transaction(async (tx) => {
        const current = (await tx.query('SELECT c.policy_version,c.mapping_version,c.mapping_status,c.company_id,c.inclusion,c.is_control,t.tracking_state,t.kind,t.company_id AS ticket_company_id FROM chats c JOIN tickets t ON t.chat_id=c.id WHERE t.id=$1 FOR UPDATE OF c', [ticketId])).rows[0];
        assert(current && current.inclusion === 'included' && !current.is_control && currentTicketMapping({ mappingStatus: current.mapping_status as typeof chat.mappingStatus, companyId: current.company_id as string | null }, { kind: current.kind as typeof ticket.kind, companyId: current.ticket_company_id as string | null }) && current.kind === ticket.kind && current.ticket_company_id === ticket.companyId && current.tracking_state === 'active' && Number(current.policy_version) === chat.policyVersion && Number(current.mapping_version) === chat.mappingVersion, 'conflict', 'Projection source policy/mapping changed');
        scoped.throwIfAborted();
        await tx.query('UPDATE tickets SET vikunja_task_id=$2 WHERE id=$1 AND (vikunja_task_id IS NULL OR vikunja_task_id=$2)', [ticketId, remote!.id]);
        await tx.query(`INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, [stateKey, JSON.stringify({ state: 'ready', hash: signature, checkedAt: this.clock.now().toISOString() })]);
      });
      return this.records.getTicket(ticketId);
    });
  }
  async projectBatch(limit = 10, signal?: AbortSignal): Promise<number> {
    const rows = (await this.db.query<{ id: string; projection_updated_at: string | null }>(`SELECT t.id,s.updated_at::text AS projection_updated_at FROM tickets t JOIN chats c ON c.id=t.chat_id LEFT JOIN app_settings s ON s.key='workflow:projection:'||t.id::text
      WHERE c.inclusion='included' AND NOT c.is_control AND t.tracking_state='active' AND (
        (t.kind='company' AND c.mapping_status='confirmed' AND c.company_id=t.company_id) OR
        (t.kind='contact_prospect' AND t.company_id IS NULL AND c.company_id IS NULL AND c.mapping_status IN ('unresolved','ambiguous')))
      ORDER BY s.updated_at ASC NULLS FIRST,t.id LIMIT $1`, [limit])).rows;
    let count = 0;
    for (const row of rows) {
      if (signal?.aborted) break;
      try { if (await this.project(row.id, signal)) count++; }
      catch (error) {
        if (signal?.aborted) break;
        const code = error instanceof DomainError ? error.code : 'upstream_unavailable';
        // Reacquire the common lock; never let a late failed callback overwrite a
        // projection successfully committed by a newer owner after session loss.
        await this.db.withSessionLock(ticketLockKey(row.id), async () => {
          // Advance failed entries too: otherwise deleted cards whose last
          // projection was ready can occupy every slot forever. Exact timestamp
          // CAS still protects a newer owner's success after session loss.
          await this.db.query(`INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb)
            ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()
            WHERE app_settings.updated_at IS NOT DISTINCT FROM $3::timestamptz`,
          [`workflow:projection:${row.id}`, JSON.stringify({ state: 'remote_unknown', code, checkedAt: this.clock.now().toISOString() }), row.projection_updated_at]);
        });
      }
    }
    return count;
  }
}
