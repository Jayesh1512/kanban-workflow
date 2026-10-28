import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Clock, Database, SqlExecutor } from '../shared/ports.js';
import { DomainError } from '../shared/api.js';
import type { FathomMeeting, FathomAction, FathomTranscriptSegment, IngestMeta, MeetingArchive, MeetingRecord, MeetingAction, MeetingCustomer, ListMeetingsInput, TranscriptInput, MeetingTaskSnapshot } from './domain.js';
import { MEETING_SCHEMA_VERSION } from './domain.js';
import { fathomMeetingSchema } from './fathom.js';
import { getMeetingSchema, listMeetingsSchema, setMeetingCustomersSchema, transcriptSchema } from './schemas.js';

type Row = { id: string; current_revision: number; record: MeetingRecord; mapping_version: number; mapping_manual: boolean; customer_state: MeetingRecord['customerState'] };
type ActionRow = { id: string; meeting_id: string; version: number; description: string; assignee: MeetingAction['assignee']; recording_timestamp: string | null; playback_url: string | null; completed: boolean; source_state: MeetingAction['sourceState']; source_revision: number; fingerprint: string; position: number; unresolved_ambiguity?: boolean; export_state?: MeetingAction['exportState']; remote_task_id?: string | null; remote_url?: string | null };
const stamp = (v: string | null | undefined) => v ? new Date(v).toISOString() : null;
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}
const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
function decode<T>(value: string, schema: z.ZodType<T>): T {
  try { return schema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))); }
  catch { throw new DomainError('validation', 'Invalid pagination cursor'); }
}
const personal = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'mail.com', 'gmx.com', 'yandex.com', 'qq.com', '163.com']);
const assignee = (a: FathomAction) => a.assignee ? { name: a.assignee.name ?? null, email: a.assignee.email ?? null, team: a.assignee.team ?? null } : null;
const identity = (a: FathomAction) => hash([a.description, a.recording_timestamp ?? null, assignee(a)]);
const anchor = (a: FathomAction) => a.recording_timestamp ? hash([a.recording_timestamp, assignee(a)]) : null;
const asSource = (a: ActionRow): FathomAction => ({ description: a.description, completed: a.completed, assignee: a.assignee, recording_timestamp: a.recording_timestamp, recording_playback_url: a.playback_url });
const actionValue = (a: ActionRow): MeetingAction => ({ id: a.id, meetingId: a.meeting_id, version: a.version, description: a.description, assignee: a.assignee, timestamp: a.recording_timestamp, playbackUrl: a.playback_url, completed: a.completed, sourceState: a.source_state, sourceRevision: a.source_revision, exportState: a.export_state ?? 'none', taskId: a.remote_task_id ?? null, taskUrl: a.remote_url ?? null });

export class MeetingRepository implements MeetingArchive {
  private readonly internal: Set<string>;
  constructor(private readonly db: Database, private readonly clock: Clock = { now: () => new Date() }, options: { internalDomains?: string[] } = {}) {
    this.internal = new Set((options.internalDomains ?? []).map(v => v.toLowerCase().trim()));
  }
  async ingestPage(items: FathomMeeting[], meta: IngestMeta = {}, tx?: SqlExecutor) {
    const parsed = z.array(fathomMeetingSchema).parse(items) as FathomMeeting[];
    const source = z.strictObject({ connectionKey: z.string().trim().min(1).max(500).optional(), observedAt: z.iso.datetime({ offset: true }).optional(), origin: z.enum(['api', 'manual']).optional() }).parse(meta);
    const work = async (sql: SqlExecutor) => {
      const result = { imported: 0, unchanged: 0 };
      for (const item of parsed) {
        const changed = await this.ingest(sql, item, { connectionKey: source.connectionKey ?? 'fathom-default', observedAt: source.observedAt ?? this.clock.now().toISOString(), origin: source.origin ?? 'api' });
        result[changed ? 'imported' : 'unchanged']++;
      }
      return result;
    };
    return tx ? work(tx) : this.db.transaction(work);
  }
  private async ingest(sql: SqlExecutor, item: FathomMeeting, meta: Required<IngestMeta>) {
    await sql.query('INSERT INTO meetings(connection_key,recording_id) VALUES($1,$2) ON CONFLICT(connection_key,recording_id) DO NOTHING', [meta.connectionKey, String(item.recording_id)]);
    const row = (await sql.query<Row>('SELECT * FROM meetings WHERE connection_key=$1 AND recording_id=$2 FOR UPDATE', [meta.connectionKey, String(item.recording_id)])).rows[0]!;
    const digest = hash(item);
    if ((await sql.query('SELECT 1 FROM meeting_revisions WHERE meeting_id=$1 AND content_hash=$2 AND revision=$3', [row.id, digest, row.current_revision])).rowCount) return false;
    const revision = row.current_revision + 1;
    const previous = row.current_revision ? row.record : undefined;
    const prior = row.current_revision ? (await sql.query<{ normalized: { transcript: FathomTranscriptSegment[] } }>('SELECT normalized FROM meeting_revisions WHERE meeting_id=$1 AND revision=$2', [row.id, row.current_revision])).rows[0]!.normalized.transcript : [];
    const transcript = item.transcript ?? prior;
    const hasSummary = item.default_summary?.markdown_formatted != null;
    const record: MeetingRecord = {
      id: row.id, title: item.meeting_title || item.title, meetingType: item.meeting_type ?? null, language: item.transcript_language ?? null,
      source: { provider: 'fathom', recordingId: String(item.recording_id), url: item.share_url ?? item.url ?? null, origin: meta.origin },
      startedAt: stamp(item.recording_start_time ?? item.scheduled_start_time), startBasis: item.recording_start_time ? 'recording' : item.scheduled_start_time ? 'scheduled' : 'unknown',
      scheduledStartAt: stamp(item.scheduled_start_time), scheduledEndAt: stamp(item.scheduled_end_time), recordingStartAt: stamp(item.recording_start_time), recordingEndAt: stamp(item.recording_end_time),
      sourceCreatedAt: stamp(item.created_at)!, observedAt: stamp(meta.observedAt)!, sourceRevision: revision,
      recorder: item.recorded_by ? { name: item.recorded_by.name ?? null, email: item.recorded_by.email ?? null } : null,
      participants: item.calendar_invitees ?? previous?.participants ?? [], customers: [], customerState: row.customer_state, mappingVersion: row.mapping_version,
      summary: { status: hasSummary ? 'available' : 'unavailable', markdown: hasSummary ? item.default_summary!.markdown_formatted! : previous?.summary.markdown ?? null, origin: 'fathom' },
      transcript: { status: item.transcript != null ? 'available' : 'unavailable', segmentCount: transcript.length, revision },
      actionsStatus: item.action_items != null ? 'available' : 'unavailable', actions: [],
    };
    if (!row.mapping_manual) await this.matchCustomers(sql, row, record.participants);
    if (item.action_items != null) await this.reconcileActions(sql, row.id, revision, item.action_items);
    const normalizedActions = (await sql.query<ActionRow>("SELECT * FROM meeting_actions WHERE meeting_id=$1 AND source_state<>'retired' ORDER BY position,id", [row.id])).rows.map(actionValue);
    await sql.query('INSERT INTO meeting_revisions(meeting_id,revision,content_hash,raw_payload,normalized,observed_at) VALUES($1,$2,$3,$4,$5,$6)', [row.id, revision, digest, JSON.stringify(item), JSON.stringify({ record, transcript, actions: normalizedActions }), meta.observedAt]);
    if (transcript.length) await sql.query(`INSERT INTO meeting_transcript_segments(meeting_id,revision,ordinal,segment) SELECT $1,$2,(ordinality-1)::integer,value FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY`, [row.id, revision, JSON.stringify(transcript)]);
    await sql.query('UPDATE meetings SET current_revision=$2,record=$3,effective_start_at=$4,source_created_at=$5 WHERE id=$1', [row.id, revision, JSON.stringify(record), record.startedAt, record.sourceCreatedAt]);
    await this.queue(sql, row.id, record);
    return true;
  }
  private async matchCustomers(sql: SqlExecutor, row: Row, invitees: MeetingRecord['participants']) {
    const companies = (await sql.query<{ id: string; domains: string[] }>('SELECT id,domains FROM companies')).rows;
    const domains = new Set(invitees.filter(v => v.is_external).map(v => (v.email_domain ?? v.email?.split('@')[1] ?? '').trim().toLowerCase()).filter(v => v && !this.internal.has(v) && !personal.has(v)));
    const ids = new Set<string>(); let collision = false;
    for (const domain of domains) {
      const matches = companies.filter(c => c.domains.some(d => d.trim().toLowerCase() === domain));
      if (matches.length === 1) ids.add(matches[0]!.id);
      else if (matches.length > 1) collision = true;
    }
    const old = (await sql.query<{ company_id: string }>('SELECT company_id FROM meeting_customer_links WHERE meeting_id=$1 ORDER BY company_id', [row.id])).rows.map(v => v.company_id);
    const next = [...ids].sort();
    const state = collision ? 'ambiguous' : ids.size ? 'confirmed' : 'unresolved';
    if (canonical(old) !== canonical(next) || state !== row.customer_state) {
      await sql.query('DELETE FROM meeting_customer_links WHERE meeting_id=$1', [row.id]);
      for (const id of next) await sql.query("INSERT INTO meeting_customer_links(meeting_id,company_id,method) VALUES($1,$2,'domain')", [row.id, id]);
      await sql.query('UPDATE meetings SET customer_state=$2,mapping_version=mapping_version+1 WHERE id=$1', [row.id, state]);
    }
  }
  private async reconcileActions(sql: SqlExecutor, meetingId: string, revision: number, incoming: FathomAction[]) {
    const old = (await sql.query<ActionRow>(`SELECT a.*,EXISTS(SELECT 1 FROM meeting_action_versions v WHERE v.action_id=a.id AND v.snapshot->>'source_state'='ambiguous') AS unresolved_ambiguity FROM meeting_actions a WHERE a.meeting_id=$1 ORDER BY a.position,a.id FOR UPDATE OF a`, [meetingId])).rows;
    const used = new Set<string>();
    const counts = new Map<string, number>();
    for (const a of incoming) counts.set(identity(a), (counts.get(identity(a)) ?? 0) + 1);
    for (const [position, a] of incoming.entries()) {
      const fingerprint = identity(a);
      const exact = old.filter(o => !used.has(o.id) && o.fingerprint === fingerprint);
      let chosen = exact.find(o => o.source_state !== 'retired') ?? exact[0];
      let uncertain = counts.get(fingerprint)! > 1;
      if (!chosen) {
        const key = anchor(a);
        const candidates = old.filter(o => !used.has(o.id) && key && anchor(asSource(o)) === key);
        const sourceCount = incoming.filter(v => key && anchor(v) === key).length;
        if (candidates.length === 1 && sourceCount === 1) chosen = candidates[0];
        else if (candidates.length || old.some(o => !used.has(o.id) && !incoming.some(v => identity(v) === o.fingerprint))) uncertain = true;
      }
      // Source-only refreshes cannot settle a previously uncertain identity, even after retirement.
      uncertain ||= chosen?.source_state === 'ambiguous' || chosen?.unresolved_ambiguity === true;
      const state = uncertain ? 'ambiguous' : 'current';
      const data = { description: a.description, assignee: assignee(a), recording_timestamp: a.recording_timestamp ?? null, playback_url: a.recording_playback_url ?? null, completed: a.completed, source_state: state };
      const changed = !chosen || canonical(data) !== canonical({ description: chosen.description, assignee: chosen.assignee, recording_timestamp: chosen.recording_timestamp, playback_url: chosen.playback_url, completed: chosen.completed, source_state: chosen.source_state });
      const id = chosen?.id ?? randomUUID(), version = (chosen?.version ?? 0) + (changed ? 1 : 0);
      used.add(id);
      await sql.query(`INSERT INTO meeting_actions(id,meeting_id,version,description,assignee,recording_timestamp,playback_url,completed,source_state,source_revision,fingerprint,position)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,description=EXCLUDED.description,assignee=EXCLUDED.assignee,recording_timestamp=EXCLUDED.recording_timestamp,playback_url=EXCLUDED.playback_url,completed=EXCLUDED.completed,source_state=EXCLUDED.source_state,source_revision=EXCLUDED.source_revision,fingerprint=EXCLUDED.fingerprint,position=EXCLUDED.position,updated_at=now()`, [id, meetingId, version, a.description, JSON.stringify(data.assignee), data.recording_timestamp, data.playback_url, a.completed, state, revision, fingerprint, position]);
      if (changed) await sql.query('INSERT INTO meeting_action_versions(action_id,version,source_revision,snapshot) VALUES($1,$2,$3,$4)', [id, version, revision, JSON.stringify(data)]);
    }
    for (const o of old.filter(o => !used.has(o.id) && o.source_state !== 'retired')) {
      await sql.query("UPDATE meeting_actions SET source_state='retired',version=version+1,source_revision=$2,updated_at=now() WHERE id=$1", [o.id, revision]);
      await sql.query('INSERT INTO meeting_action_versions(action_id,version,source_revision,snapshot) VALUES($1,$2,$3,$4)', [o.id, o.version + 1, revision, JSON.stringify({ ...asSource(o), source_state: 'retired' })]);
    }
  }
  private async queue(sql: SqlExecutor, meetingId: string, record: MeetingRecord) {
    const names = (await this.customerLinks(sql, meetingId)).map(c => c.name);
    await sql.query(`UPDATE meeting_task_exports e SET state='canceled',updated_at=$2 FROM meeting_actions a WHERE e.action_id=a.id AND a.meeting_id=$1 AND (a.source_state<>'current' OR a.completed) AND e.state IN ('queued','failed','canceled') AND e.request_id IS NULL`, [meetingId, this.clock.now().toISOString()]);
    const actions = (await sql.query<ActionRow>("SELECT * FROM meeting_actions WHERE meeting_id=$1 AND source_state='current' AND NOT completed ORDER BY position,id FOR UPDATE", [meetingId])).rows;
    for (const a of actions) {
      const snapshot: MeetingTaskSnapshot = { actionId: a.id, actionVersion: a.version, meetingId, meetingTitle: record.title, title: a.description, description: a.description, customerNames: names, sourceUrl: record.source.url, playbackUrl: a.playback_url, timestamp: a.recording_timestamp, assignee: a.assignee, dueAt: null };
      await sql.query(`INSERT INTO meeting_task_exports(action_id,action_version,state,snapshot) VALUES($1,$2,'queued',$3)
        ON CONFLICT(action_id) DO UPDATE SET action_version=EXCLUDED.action_version,snapshot=EXCLUDED.snapshot,state='queued',last_error=NULL,updated_at=now(),next_attempt_at=now()
        WHERE meeting_task_exports.state IN ('queued','failed','canceled') AND meeting_task_exports.request_id IS NULL AND (meeting_task_exports.action_version<>EXCLUDED.action_version OR meeting_task_exports.state='canceled' OR meeting_task_exports.snapshot<>EXCLUDED.snapshot)`, [a.id, a.version, JSON.stringify(snapshot)]);
    }
  }
  private async customerLinks(sql: SqlExecutor, id: string): Promise<MeetingCustomer[]> {
    return (await sql.query<MeetingCustomer>(`SELECT c.id,c.canonical_name AS name,l.method,'confirmed' AS state FROM meeting_customer_links l JOIN companies c ON c.id=l.company_id WHERE l.meeting_id=$1 ORDER BY c.canonical_name,c.id`, [id])).rows;
  }
  private async read(sql: SqlExecutor, id: string): Promise<MeetingRecord> {
    const row = (await sql.query<Row & { customers: MeetingCustomer[]; actions: ActionRow[]; retired_actions: ActionRow[] }>(`SELECT m.*,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id,'name',c.canonical_name,'method',l.method,'state','confirmed') ORDER BY c.canonical_name,c.id) FROM meeting_customer_links l JOIN companies c ON c.id=l.company_id WHERE l.meeting_id=m.id),'[]'::jsonb) AS customers,
      COALESCE((SELECT jsonb_agg(to_jsonb(details) ORDER BY details.position,details.id) FROM (
        SELECT a.*,COALESCE(e.state,'none') AS export_state,e.remote_task_id,e.remote_url FROM meeting_actions a LEFT JOIN meeting_task_exports e ON e.action_id=a.id WHERE a.meeting_id=m.id AND a.source_state<>'retired'
      ) details),'[]'::jsonb) AS actions,
      COALESCE((SELECT jsonb_agg(to_jsonb(history) ORDER BY history.position,history.id) FROM (
        SELECT a.*,e.state AS export_state,e.remote_task_id,e.remote_url FROM meeting_actions a JOIN meeting_task_exports e ON e.action_id=a.id
        WHERE a.meeting_id=m.id AND a.source_state='retired' AND (e.request_id IS NOT NULL OR e.state IN ('created','dispatched','unknown'))
      ) history),'[]'::jsonb) AS retired_actions
      FROM meetings m WHERE m.id=$1 AND m.current_revision>0`, [id])).rows[0];
    if (!row) throw new DomainError('not_found', 'Meeting not found');
    return { ...row.record, customerState: row.customer_state, mappingVersion: row.mapping_version, customers: row.customers, actions: row.actions.map(actionValue), retiredActions: row.retired_actions.map(actionValue) };
  }

  async get(id: string) {
    getMeetingSchema.parse({ id });
    return { schemaVersion: MEETING_SCHEMA_VERSION, meeting: await this.read(this.db, id) };
  }
  async list(input: ListMeetingsInput) {
    const parsed = listMeetingsSchema.parse(input), { cursor, limit = 50, ...filters } = parsed;
    const filterHash = hash(filters);
    const after = cursor ? decode(cursor, z.strictObject({ hash: z.string(), start: z.iso.datetime({ offset: true }), id: z.uuid() })) : null;
    if (after && after.hash !== filterHash) throw new DomainError('validation', 'Cursor does not match meeting filters');
    const values: unknown[] = [];
    const add = (value: unknown) => { values.push(value); return `$${values.length}`; };
    const where = ['m.current_revision>0'];
    if (filters.customerId) where.push(`EXISTS(SELECT 1 FROM meeting_customer_links l WHERE l.meeting_id=m.id AND l.company_id=${add(filters.customerId)})`);
    if (filters.customerState === 'unresolved') where.push("m.customer_state<>'confirmed'");
    else if (filters.customerState) where.push(`m.customer_state=${add(filters.customerState)}`);
    if (filters.from) where.push(`m.effective_start_at>=${add(filters.from)}::timestamptz`);
    if (filters.to) where.push(`m.effective_start_at<${add(filters.to)}::timestamptz`);
    if (filters.recorder) { const p = add(filters.recorder.toLowerCase()); where.push(`(lower(m.record#>>'{recorder,name}')=${p} OR lower(m.record#>>'{recorder,email}')=${p})`); }
    if (filters.meetingType) where.push(`m.record->>'meetingType'=${add(filters.meetingType)}`);
    if (filters.transcriptStatus) where.push(`m.record#>>'{transcript,status}'=${add(filters.transcriptStatus)}`);
    if (filters.exportState) {
      const p = add(filters.exportState);
      where.push(`EXISTS(SELECT 1 FROM meeting_actions a LEFT JOIN meeting_task_exports e ON e.action_id=a.id WHERE a.meeting_id=m.id AND a.source_state<>'retired' AND COALESCE(e.state,'none')=${p})`);
    }
    if (filters.query) {
      const p = add(filters.query.toLowerCase());
      where.push(`(strpos(lower(m.record->>'title'),${p})>0 OR strpos(lower(COALESCE(m.record#>>'{summary,markdown}','')),${p})>0 OR EXISTS(SELECT 1 FROM meeting_transcript_segments s WHERE s.meeting_id=m.id AND s.revision=m.current_revision AND strpos(lower(s.segment->>'text'),${p})>0) OR EXISTS(SELECT 1 FROM meeting_actions a WHERE a.meeting_id=m.id AND a.source_state<>'retired' AND strpos(lower(a.description),${p})>0))`);
    }
    const total = Number((await this.db.query<{ count: string }>(`SELECT count(*) FROM meetings m WHERE ${where.join(' AND ')}`, values)).rows[0]!.count);
    if (after) where.push(`(COALESCE(m.effective_start_at,'0001-01-01T00:00:00Z'::timestamptz),m.id)<(${add(after.start)}::timestamptz,${add(after.id)}::uuid)`);
    const rows = (await this.db.query<{ id: string; record: MeetingRecord }>(`SELECT m.id,m.record FROM meetings m WHERE ${where.join(' AND ')} ORDER BY COALESCE(m.effective_start_at,'0001-01-01T00:00:00Z'::timestamptz) DESC,m.id DESC LIMIT ${add(limit + 1)}`, values)).rows;
    const selected = rows.slice(0, limit), last = selected.at(-1);
    const items: MeetingRecord[] = [];
    for (const row of selected) items.push(await this.read(this.db, row.id));
    return { schemaVersion: MEETING_SCHEMA_VERSION, items, total, nextCursor: rows.length > limit && last ? encode({ hash: filterHash, start: last.record.startedAt ?? '0001-01-01T00:00:00Z', id: last.id }) : null };
  }
  async transcript(input: TranscriptInput) {
    const parsed = transcriptSchema.parse(input), limit = parsed.limit ?? 200;
    const after = parsed.cursor ? decode(parsed.cursor, z.strictObject({ id: z.uuid(), revision: z.number().int().positive(), offset: z.number().int().nonnegative() })) : null;
    if (after && (after.id !== parsed.id || (parsed.revision !== undefined && after.revision !== parsed.revision))) throw new DomainError('validation', 'Transcript cursor does not match meeting/revision');
    const meeting = (await this.db.query<{ current_revision: number }>('SELECT current_revision FROM meetings WHERE id=$1 AND current_revision>0', [parsed.id])).rows[0];
    if (!meeting) throw new DomainError('not_found', 'Meeting not found');
    const revision = after?.revision ?? parsed.revision ?? meeting.current_revision;
    const snapshot = (await this.db.query<{ normalized: { record: MeetingRecord } }>('SELECT normalized FROM meeting_revisions WHERE meeting_id=$1 AND revision=$2', [parsed.id, revision])).rows[0];
    if (!snapshot) throw new DomainError('not_found', 'Meeting revision not found');
    const offset = after?.offset ?? 0, total = snapshot.normalized.record.transcript.segmentCount;
    const items = (await this.db.query<{ segment: FathomTranscriptSegment }>('SELECT segment FROM meeting_transcript_segments WHERE meeting_id=$1 AND revision=$2 AND ordinal>=$3 ORDER BY ordinal LIMIT $4', [parsed.id, revision, offset, limit])).rows.map(v => v.segment);
    return { schemaVersion: MEETING_SCHEMA_VERSION, meetingId: parsed.id, revision, status: snapshot.normalized.record.transcript.status, items, total, nextCursor: offset + items.length < total ? encode({ id: parsed.id, revision, offset: offset + items.length }) : null };
  }
  async customers() {
    const items = (await this.db.query<{ id: string; name: string; domains: string[]; meetingCount: number }>(`SELECT c.id,c.canonical_name AS name,c.domains,count(l.meeting_id)::integer AS "meetingCount" FROM companies c LEFT JOIN meeting_customer_links l ON l.company_id=c.id GROUP BY c.id ORDER BY c.canonical_name,c.id`)).rows;
    const unresolvedCount = Number((await this.db.query<{ count: string }>("SELECT count(*) FROM meetings WHERE current_revision>0 AND customer_state<>'confirmed'")).rows[0]!.count);
    return { schemaVersion: MEETING_SCHEMA_VERSION, items, unresolvedCount };
  }
  async setCustomers(input: { id: string; companyIds: string[]; expectedVersion: number; reason: string }) {
    const parsed = setMeetingCustomersSchema.parse(input);
    return this.db.transaction(async sql => {
      const row = (await sql.query<Row>('SELECT * FROM meetings WHERE id=$1 AND current_revision>0 FOR UPDATE', [parsed.id])).rows[0];
      if (!row) throw new DomainError('not_found', 'Meeting not found');
      if (row.mapping_version !== parsed.expectedVersion) throw new DomainError('conflict', 'Customer mapping changed; reload before correcting');
      if (parsed.companyIds.length) {
        const found = await sql.query('SELECT id FROM companies WHERE id=ANY($1::uuid[])', [parsed.companyIds]);
        if (found.rowCount !== parsed.companyIds.length) throw new DomainError('validation', 'Unknown customer');
      }
      await sql.query('DELETE FROM meeting_customer_links WHERE meeting_id=$1', [parsed.id]);
      for (const companyId of parsed.companyIds) await sql.query("INSERT INTO meeting_customer_links(meeting_id,company_id,method) VALUES($1,$2,'manual')", [parsed.id, companyId]);
      await sql.query('UPDATE meetings SET mapping_manual=true,mapping_version=mapping_version+1,customer_state=$2 WHERE id=$1', [parsed.id, parsed.companyIds.length ? 'confirmed' : 'unresolved']);
      await sql.query('INSERT INTO meeting_customer_corrections(meeting_id,version,company_ids,reason,created_at) VALUES($1,$2,$3,$4,$5)', [parsed.id, row.mapping_version + 1, parsed.companyIds, parsed.reason, this.clock.now().toISOString()]);
      await this.queue(sql, parsed.id, row.record);
      return { schemaVersion: MEETING_SCHEMA_VERSION, meeting: await this.read(sql, parsed.id) };
    });
  }
}
