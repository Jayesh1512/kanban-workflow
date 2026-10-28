import { AsyncResource } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Clock, Database, SqlExecutor } from '../shared/ports.js';
import type { MeetingRemoteTask, MeetingTaskPort, MeetingTaskSnapshot } from './domain.js';

type ExportRow = { id: string; action_id: string; action_version: number; state: string; snapshot: MeetingTaskSnapshot; request_id: string | null; claim_token: string | null };
export const meetingActionMarker = (actionId: string): string => `[meeting-action:${actionId}]`;
/** A durable dispatch barrier deliberately trades progress for avoiding a second uncertain create. */
export class MeetingTaskPublisher {
  private readonly receipts = new AsyncResource('meeting-task-receipts');
  constructor(private readonly db: Database, private readonly port: MeetingTaskPort | null, private readonly clock: Clock = { now: () => new Date() }) {}
  async status(): Promise<unknown> {
    const counts = (await this.db.query<{ state: string; count: string }>('SELECT state,count(*)::text AS count FROM meeting_task_exports GROUP BY state')).rows;
    const exclusive = ((await this.db.query("SELECT 1 FROM app_settings WHERE key='telegram:approval-exclusive-sources'")).rowCount ?? 0) > 0;
    return { configured: this.port !== null, automatic: !exclusive, counts: Object.fromEntries(counts.map(r => [r.state, Number(r.count)])) };
  }
  private async receipt(requestId: string, task: MeetingRemoteTask | null): Promise<void> {
    const sql = "INSERT INTO meeting_remote_receipts(request_id,outcome,remote_task_id,remote_url) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING";
    const args = [requestId, task ? 'created' : 'unknown', task?.id ?? null, task?.url ?? null];
    try { await this.db.query(sql, args); }
    catch { await this.receipts.runInAsyncScope(() => this.db.query(sql, args)); }
  }
  private async locked<T>(actionId: string, exportId: string, work: (tx: SqlExecutor, row: ExportRow) => Promise<T>): Promise<T | undefined> {
    return this.db.transaction(async tx => {
      // The archive takes these same row locks in this order for source retirement.
      await tx.query('SELECT id FROM meeting_actions WHERE id=$1 FOR UPDATE', [actionId]);
      const row = (await tx.query<ExportRow>('SELECT * FROM meeting_task_exports WHERE id=$1 FOR UPDATE', [exportId])).rows[0];
      if (row) return work(tx, row);
    });
  }
  async tick(signal?: AbortSignal): Promise<void> {
    if (!this.port || signal?.aborted) return;
    if ((await this.db.query("SELECT 1 FROM app_settings WHERE key='telegram:approval-exclusive-sources'")).rowCount) {
      await this.retireOne(signal);
      return;
    }
    const candidate = (await this.db.query<ExportRow>(`SELECT * FROM meeting_task_exports WHERE state IN ('queued','failed','dispatched','unknown') AND next_attempt_at<=GREATEST($1::timestamptz,now()) ORDER BY next_attempt_at,id LIMIT 1`, [this.clock.now()])).rows[0];
    if (!candidate) return;
    try {
      await this.db.withSessionLock(`meeting:action:${candidate.action_id}`, async (_session, lost) => {
        const s = signal ? AbortSignal.any([signal, lost]) : lost;
        s.throwIfAborted();
        const token = randomUUID();
        const row = await this.locked(candidate.action_id, candidate.id, async (tx, current) => {
          if (!['queued','failed','dispatched','unknown'].includes(current.state)) return null;
          await tx.query('UPDATE meeting_task_exports SET claim_token=$2,updated_at=now() WHERE id=$1', [current.id, token]);
          return current;
        });
        if (!row) return;
        try {
          await this.port!.prepare(s);
          s.throwIfAborted();
          if (row.request_id || row.state === 'dispatched' || row.state === 'unknown') {
            await this.reconcile(row, token, s);
            return;
          }
          // Authentication and existing-project verification completed before recording intent.
          const requestId = randomUUID();
          const dispatch = await this.locked(row.action_id, row.id, async (tx, current) => {
            if (current.claim_token !== token || current.request_id || !['queued','failed'].includes(current.state)) return null;
            const action = (await tx.query<{ version: number; completed: boolean; source_state: string }>('SELECT version,completed,source_state FROM meeting_actions WHERE id=$1', [row.action_id])).rows[0];
            if (!action || action.completed || action.source_state !== 'current' || action.version !== current.action_version || current.snapshot.actionVersion !== action.version || current.snapshot.actionId !== row.action_id) {
              await tx.query("UPDATE meeting_task_exports SET state='canceled',last_error='Source action is no longer eligible',updated_at=now() WHERE id=$1", [row.id]);
              return null;
            }
            s.throwIfAborted();
            await tx.query('INSERT INTO meeting_remote_requests(id,export_id,action_id,action_version,marker,snapshot) VALUES($1,$2,$3,$4,$5,$6)', [requestId, row.id, row.action_id, current.action_version, meetingActionMarker(row.action_id), JSON.stringify(current.snapshot)]);
            await tx.query("UPDATE meeting_task_exports SET state='dispatched',request_id=$2,dispatched_at=now(),last_error=NULL,updated_at=now() WHERE id=$1", [row.id, requestId]);
            return current.snapshot;
          });
          if (!dispatch) return;
          let task: MeetingRemoteTask;
          try {
            s.throwIfAborted();
            // Exactly one invocation; no automatic retry, including after a zero-match reconciliation.
            task = await this.port!.create(dispatch, meetingActionMarker(row.action_id), s);
            await this.receipt(requestId, task);
          } catch {
            await this.receipt(requestId, null).catch(() => {});
            throw new Error('Task creation outcome is unknown; creation will not be retried');
          }
          s.throwIfAborted();
          await this.finish(row, token, task);
        } catch {
          s.throwIfAborted();
          await this.locked(row.action_id, row.id, async (tx, current) => {
            if (current.claim_token !== token) return;
            await tx.query(`UPDATE meeting_task_exports SET state=CASE WHEN request_id IS NULL THEN 'failed' ELSE 'unknown' END,last_error=CASE WHEN request_id IS NULL THEN 'Task destination is unavailable; retrying preparation' ELSE 'Task outcome unresolved; automatic creation is blocked' END,next_attempt_at=$2,updated_at=now() WHERE id=$1`, [row.id, new Date(this.clock.now().getTime() + 60_000)]);
          });
        }
      });
    } catch {
      // Session loss fences the owner and aborts HTTP. The committed barrier survives restart.
      // Do not use this unowned scope to finalize business state.
    }
  }
  private async retireOne(signal?: AbortSignal): Promise<void> {
    const row = (await this.db.query<ExportRow & { remote_task_id: string | null }>(`SELECT * FROM meeting_task_exports
      WHERE state IN ('queued','failed','canceled','created') ORDER BY updated_at,id LIMIT 1`)).rows[0];
    if (!row) return;
    await this.db.withSessionLock(`meeting:action:${row.action_id}`, async (_session, lost) => {
      const s = signal ? AbortSignal.any([signal,lost]) : lost; s.throwIfAborted();
      if (row.state === 'created' && row.remote_task_id) {
        if (!this.port?.retire) throw new Error('Meeting task retirement is unavailable');
        await this.port.prepare(s);
        await this.port.retire(row.remote_task_id, meetingActionMarker(row.action_id), s);
      }
      await this.db.query("UPDATE meeting_task_exports SET state='retired',remote_url=NULL,last_error='Non-Telegram source retired by approval-exclusive policy',claim_token=NULL,updated_at=now() WHERE id=$1 AND state IN ('queued','failed','canceled','created')", [row.id]);
    });
  }
  private async finish(row: ExportRow, token: string, task: MeetingRemoteTask): Promise<void> {
    await this.locked(row.action_id, row.id, async (tx, current) => {
      if (current.claim_token !== token || !current.request_id) return;
      await tx.query("UPDATE meeting_task_exports SET state='created',remote_task_id=$2,remote_url=$3,last_error=NULL,updated_at=now() WHERE id=$1", [row.id, task.id, task.url]);
    });
  }
  private async reconcile(row: ExportRow, token: string, signal: AbortSignal): Promise<void> {
    const receipt = row.request_id ? (await this.db.query<{ outcome: string; remote_task_id: string | null; remote_url: string | null }>('SELECT * FROM meeting_remote_receipts WHERE request_id=$1', [row.request_id])).rows[0] : null;
    if (receipt?.outcome === 'created' && receipt.remote_task_id) {
      signal.throwIfAborted();
      await this.finish(row, token, { id: receipt.remote_task_id, url: receipt.remote_url });
      return;
    }
    const matches = await this.port!.find(meetingActionMarker(row.action_id), signal);
    signal.throwIfAborted();
    await this.locked(row.action_id, row.id, async (tx, current) => {
      if (current.claim_token !== token) return;
      await tx.query('INSERT INTO meeting_task_reconciliations(export_id,match_count,matches) VALUES($1,$2,$3)', [row.id, matches.length, JSON.stringify(matches)]);
      const task = matches.length === 1 ? matches[0]! : null;
      await tx.query(`UPDATE meeting_task_exports SET state=$2,remote_task_id=$3,remote_url=$4,last_error=$5,next_attempt_at=$6,updated_at=now() WHERE id=$1`, [row.id, task ? 'created' : 'unknown', task?.id ?? null, task?.url ?? null, task ? null : matches.length > 1 ? 'Conflict: multiple tasks contain the exact action marker' : 'No matching task observed; original request may still commit; creation remains blocked', new Date(this.clock.now().getTime() + 60_000)]);
    });
  }
}
