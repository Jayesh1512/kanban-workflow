import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from '../shared/api.js';
import type { Clock, Database, SqlExecutor } from '../shared/ports.js';
import type { MeetingArchive, MeetingConfig } from './domain.js';
import { FathomClient, FathomError } from './fathom.js';

const CONNECTION = 'fathom-default';
const DAY = 86_400_000;
interface Run {
  id: string; status: string; kind: string; created_after: Date | string; created_before: Date | string;
  cursor: string | null; lease_token: string | null; attempts: number; request_hash: string;
  [key: string]: unknown;
}
interface SyncState { auth_paused: boolean; poll_created_before: Date | string | null; retry_at: Date | string | null; next_scan_at: Date | string | null; [key: string]: unknown }
export interface ImportInput { idempotencyKey: string; createdAfter?: string; createdBefore?: string }
const iso = (value: Date | string) => new Date(value).toISOString();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Durable single-connection scans. A tick does one page and never sleeps or holds SQL across HTTP. */
export class MeetingSync {
  private readonly client: FathomClient;
  private ticking = false;
  constructor(private readonly db: Database, private readonly archive: MeetingArchive, private readonly config: MeetingConfig,
    private readonly clock: Clock = { now: () => new Date() }, options: { client?: FathomClient } = {}) {
    this.client = options.client ?? new FathomClient({ apiKey: config.apiKey ?? '', timeoutMs: config.timeoutMs, clock });
  }
  private async state(tx: SqlExecutor): Promise<SyncState> {
    const fingerprint = hash(`${this.config.enabled}:${this.config.apiKey ?? ''}`);
    await tx.query(`INSERT INTO meeting_sync_state(connection_key,config_fingerprint) VALUES($1,$2) ON CONFLICT(connection_key) DO NOTHING`, [CONNECTION, fingerprint]);
    const row = (await tx.query<SyncState>('SELECT * FROM meeting_sync_state WHERE connection_key=$1 FOR UPDATE', [CONNECTION])).rows[0]!;
    if (row.config_fingerprint !== fingerprint) {
      await tx.query('UPDATE meeting_sync_state SET config_fingerprint=$2,auth_paused=false,retry_at=NULL,last_error=NULL,updated_at=$3 WHERE connection_key=$1', [CONNECTION, fingerprint, this.clock.now()]);
      await tx.query("UPDATE meeting_import_runs SET status='queued',retry_at=NULL WHERE connection_key=$1 AND status='paused'", [CONNECTION]);
      row.auth_paused = false;
      row.retry_at = null;
    }
    return row;
  }
  async requestImport(input: ImportInput): Promise<unknown> {
    if (!input.idempotencyKey?.trim() || input.idempotencyKey.length > 200) throw new DomainError('validation', 'A bounded idempotency key is required');
    const requestHash = hash(JSON.stringify({ after: input.createdAfter ?? null, before: input.createdBefore ?? null }));
    return this.db.transaction(async tx => {
      await this.state(tx);
      const existing = (await tx.query<Run>('SELECT * FROM meeting_import_runs WHERE connection_key=$1 AND idempotency_key=$2', [CONNECTION, `manual:${input.idempotencyKey}`])).rows[0];
      if (existing) {
        if (existing.request_hash !== requestHash) throw new DomainError('conflict', 'Import key was already used with different bounds');
        await this.resumeAuthentication(tx);
        return this.publicRun({ ...existing, status: existing.status === 'paused' ? 'queued' : existing.status });
      }
      const before = input.createdBefore ? new Date(input.createdBefore) : this.clock.now();
      const after = input.createdAfter ? new Date(input.createdAfter) : new Date(before.getTime() - 30 * DAY);
      const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
      if ((input.createdAfter && !timestamp.test(input.createdAfter)) || (input.createdBefore && !timestamp.test(input.createdBefore)) ||
        !Number.isFinite(before.getTime()) || !Number.isFinite(after.getTime()) || after >= before || before.getTime() - after.getTime() > 366 * DAY)
        throw new DomainError('validation', 'Creation-time import window must be valid and at most 366 days');
      await this.resumeAuthentication(tx);
      return this.publicRun(await this.enqueue(tx, 'manual', `manual:${input.idempotencyKey}`, requestHash, after, before));
    });
  }
  private async resumeAuthentication(tx: SqlExecutor) {
    await tx.query('UPDATE meeting_sync_state SET retry_at=CASE WHEN auth_paused THEN NULL ELSE retry_at END,auth_paused=false,last_error=NULL WHERE connection_key=$1', [CONNECTION]);
    await tx.query("UPDATE meeting_import_runs SET status='queued',retry_at=NULL WHERE connection_key=$1 AND status='paused'", [CONNECTION]);
  }
  private async enqueue(tx: SqlExecutor, kind: string, key: string, requestHash: string, after: Date, before: Date): Promise<Run> {
    return (await tx.query<Run>(`INSERT INTO meeting_import_runs(id,connection_key,idempotency_key,request_hash,kind,created_after,created_before,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`, [randomUUID(), CONNECTION, key, requestHash, kind, after, before, this.clock.now()])).rows[0]!;
  }
  private publicRun(row: Run): Record<string, unknown> {
    return { id: row.id, status: row.status, kind: row.kind, createdAfter: iso(row.created_after), createdBefore: iso(row.created_before),
      cursor: row.cursor, pages: row.pages, imported: row.imported, unchanged: row.unchanged, attempts: row.attempts,
      lastError: row.last_error ?? null, retryAt: row.retry_at ?? null, completedAt: row.completed_at ?? null };
  }
  async status(): Promise<unknown> {
    const state = (await this.db.query<SyncState>('SELECT * FROM meeting_sync_state WHERE connection_key=$1', [CONNECTION])).rows[0];
    const runs = (await this.db.query<Run>('SELECT * FROM meeting_import_runs WHERE connection_key=$1 ORDER BY created_at DESC,id DESC LIMIT 20', [CONNECTION])).rows;
    const pending = (await this.db.query<{ count: string }>('SELECT count(*)::text AS count FROM meeting_webhook_inbox WHERE connection_key=$1 AND processed_at IS NULL', [CONNECTION])).rows[0]!;
    return { enabled: this.config.enabled, configured: !!this.config.apiKey, webhookConfigured: !!this.config.webhookSecret,
      state: !this.config.enabled ? 'disabled' : !this.config.apiKey ? 'unconfigured' : state?.auth_paused ? 'authentication_required' : 'ready',
      coverage: { createdAfter: state?.coverage_created_after ?? null, createdBefore: state?.coverage_created_before ?? null, lastSuccessAt: state?.last_success_at ?? null,
        basis: 'Fathom creation time; overlapping scans do not discover arbitrary edits to older recordings' },
      lastError: state?.last_error ?? null, retryAt: state?.retry_at ?? null, webhookPending: Number(pending.count), lastImport: runs[0] ? this.publicRun(runs[0]) : null, runs: runs.map(row => this.publicRun(row)) };
  }
  async tick(signal?: AbortSignal): Promise<void> {
    if (!this.config.enabled || !this.config.apiKey || signal?.aborted || this.ticking) return;
    this.ticking = true;
    try {
      const run = await this.claim();
      if (!run) return;
      if (signal?.aborted) { await this.fail(run, new FathomError('aborted', 'Fathom request canceled')); return; }
      try {
        const page = await this.client.listMeetings({ createdAfter: iso(run.created_after), createdBefore: iso(run.created_before), cursor: run.cursor }, signal);
        if (page.next_cursor && (page.next_cursor === run.cursor || (Array.isArray(run.cursor_history) && run.cursor_history.includes(page.next_cursor))))
          throw new FathomError('invalid_response', 'Fathom returned a repeated pagination cursor');
        await this.db.transaction(async tx => {
          if (!await this.owns(tx, run)) return;
          const result = await this.archive.ingestPage(page.items, { connectionKey: CONNECTION, observedAt: this.clock.now().toISOString(), origin: 'api' }, tx);
          const complete = page.next_cursor === null;
          await tx.query(`UPDATE meeting_import_runs SET cursor=$2,cursor_history=CASE WHEN $2::text IS NULL THEN cursor_history ELSE array_append(cursor_history,$2::text) END,status=$3,pages=pages+1,imported=imported+$4,unchanged=unchanged+$5,
            lease_token=NULL,lease_until=NULL,retry_at=NULL,last_error=NULL,updated_at=$6,completed_at=$7 WHERE id=$1`,
          [run.id, page.next_cursor, complete ? 'completed' : 'queued', result.imported, result.unchanged, this.clock.now(), complete ? this.clock.now() : null]);
          if (complete) {
            await tx.query(`UPDATE meeting_sync_state SET last_success_at=$2,last_error=NULL,retry_at=NULL,
              coverage_created_after=$3,coverage_created_before=$4,
              poll_created_before=CASE WHEN $5='poll' THEN $4::timestamptz ELSE poll_created_before END,
              updated_at=$2 WHERE connection_key=$1`, [CONNECTION, this.clock.now(), run.created_after, run.created_before, run.kind]);
            await tx.query('UPDATE meeting_webhook_inbox SET processed_at=$2 WHERE run_id=$1 AND processed_at IS NULL', [run.id, this.clock.now()]);
          }
        });
      } catch (error) { await this.fail(run, error); }
    } finally { this.ticking = false; }
  }
  private async claim(): Promise<Run | null> {
    return this.db.transaction(async tx => {
      const state = await this.state(tx); const now = this.clock.now();
      if (state.auth_paused || (state.retry_at && new Date(state.retry_at) > now)) return null;
      // The connection row serializes claims, while a lease serializes canonical observations across processes.
      const active = await tx.query('SELECT id FROM meeting_import_runs WHERE connection_key=$1 AND status=\'running\' AND lease_until>$2 LIMIT 1', [CONNECTION, now]);
      if (active.rows.length) return null;
      let row = (await tx.query<Run>(`SELECT * FROM meeting_import_runs WHERE connection_key=$1 AND
        (status='queued' OR (status='retry' AND retry_at<=$2) OR (status='running' AND lease_until<=$2)) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`, [CONNECTION, now])).rows[0];
      if (!row) {
        const pending = await tx.query('SELECT id FROM meeting_webhook_inbox WHERE connection_key=$1 AND run_id IS NULL AND processed_at IS NULL LIMIT 1', [CONNECTION]);
        const due = !state.next_scan_at || new Date(state.next_scan_at) <= now;
        if (!pending.rows.length && !due) return null;
        const kind = pending.rows.length ? 'webhook' : 'poll';
        // Unknown webhook fields cannot select recordings or widen the window.
        const before = now;
        const checkpoint = state.poll_created_before ? new Date(state.poll_created_before).getTime() - DAY : now.getTime() - 30 * DAY;
        const after = new Date(kind === 'webhook' ? now.getTime() - 30 * DAY : Math.min(checkpoint, now.getTime() - DAY));
        row = await this.enqueue(tx, kind, `${kind}:${randomUUID()}`, '', after, before);
        if (kind === 'webhook') await tx.query('UPDATE meeting_webhook_inbox SET run_id=$2 WHERE connection_key=$1 AND run_id IS NULL AND processed_at IS NULL', [CONNECTION, row.id]);
        await tx.query('UPDATE meeting_sync_state SET next_scan_at=$2 WHERE connection_key=$1', [CONNECTION, new Date(now.getTime() + Math.max(this.config.pollIntervalMs, 1000))]);
      }
      const token = randomUUID();
      return (await tx.query<Run>(`UPDATE meeting_import_runs SET status='running',lease_token=$2,lease_until=$3,attempts=attempts+1,updated_at=$4 WHERE id=$1 RETURNING *`,
        [row.id, token, new Date(now.getTime() + Math.max(this.config.timeoutMs * 2, 60_000)), now])).rows[0]!;
    });
  }
  private async owns(tx: SqlExecutor, run: Run): Promise<boolean> {
    // Match claim's connection→run lock order and serialize canonical page commits.
    await tx.query('SELECT connection_key FROM meeting_sync_state WHERE connection_key=$1 FOR UPDATE', [CONNECTION]);
    const row = await tx.query("SELECT id FROM meeting_import_runs WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_until>$3 FOR UPDATE", [run.id, run.lease_token, this.clock.now()]);
    return !!row.rows.length;
  }
  private async fail(run: Run, error: unknown) {
    const auth = error instanceof FathomError && error.code === 'authentication';
    const delay = error instanceof FathomError && error.retryAfterMs !== null ? error.retryAfterMs : Math.min(1000 * 2 ** Math.min(run.attempts, 10), 300_000);
    // Source values and secrets never enter persisted errors.
    const message = error instanceof FathomError ? error.message : 'Meeting page could not be committed';
    await this.db.transaction(async tx => {
      if (!await this.owns(tx, run)) return;
      await tx.query(`UPDATE meeting_import_runs SET status=$2,last_error=$3,retry_at=$4,lease_token=NULL,lease_until=NULL,updated_at=$5 WHERE id=$1`,
        [run.id, auth ? 'paused' : 'retry', message, new Date(this.clock.now().getTime() + delay), this.clock.now()]);
      await tx.query('UPDATE meeting_sync_state SET auth_paused=$2,last_error=$3,updated_at=$4,retry_at=$5 WHERE connection_key=$1', [CONNECTION, auth, message, this.clock.now(), new Date(this.clock.now().getTime() + delay)]);
    });
  }
}
