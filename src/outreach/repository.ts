import type { Clock, Database, SqlExecutor } from '../shared/ports.js';
import type { OutreachContact, OutreachDetail, OutreachListInput, OutreachRelationship, OutreachService, OutreachSource, OutreachSourceContext } from '../shared/outreach-domain.js';
import { outreachGetSchema, outreachListSchema } from '../shared/outreach-schemas.js';
import { DomainError } from '../shared/api.js';
import { factRows } from '../workflow/records.js';
import { iso, nullableIso, type Row } from '../workflow/sql.js';
import type { DateFact } from '../shared/domain.js';

const joins = `FROM outreach_relationship_sources rs JOIN outreach_source_threads s ON s.id=rs.source_thread_id
 LEFT JOIN outreach_telegram_inputs i ON i.ticket_id=s.ticket_id`;
const eligible = `((s.kind='telegram' AND i.inclusion='included' AND NOT i.is_control AND i.tracking_state='active') OR (s.kind='email_report' AND coalesce(s.coverage->>'superseded','false')<>'true'))`;
const identityMatches = `(s.kind<>'telegram' OR r.company_id IS NOT DISTINCT FROM i.company_id)`;

/** Read model only. No provider, Telegram or Vikunja dependency, decision or apply path. */
export class OutreachRepository implements OutreachService {
  constructor(private readonly db: Database, private readonly clock: Clock) {}

  /** Bounded rotating database sweep. One chat per transaction keeps lock order
   * chat -> ticket -> relationship; source/operator writers never wait on a batch. */
  async reconcile(limit = 25): Promise<void> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainError('validation', 'Invalid outreach reconciliation limit');
    const cursor = (await this.db.query<{ value: { after?: string } }>("SELECT value FROM app_settings WHERE key='outreach:reconcile-cursor'")).rows[0]?.value.after ?? null;
    const rows = (await this.db.query<{ chat_id: string }>(`SELECT t.chat_id::text FROM tickets t LEFT JOIN outreach_source_threads s ON s.ticket_id=t.id
      WHERE ($1::bigint IS NULL OR t.chat_id>$1 OR s.id IS NULL)
        AND NOT EXISTS(SELECT 1 FROM app_settings e WHERE e.key='outreach:reconcile-error:'||t.chat_id::text
          AND (e.value->>'at')::timestamptz>now()-interval '5 minutes')
      ORDER BY (s.id IS NULL) DESC,t.chat_id LIMIT $2`, [cursor, limit])).rows;
    for (const row of rows) {
      const key = `outreach:reconcile-error:${row.chat_id}`;
      try {
        await this.reconcileChat(row.chat_id);
        await this.db.query('DELETE FROM app_settings WHERE key=$1', [key]);
      } catch {
        // One bad source must not keep the cursor on the same batch forever.
        await this.db.query(`INSERT INTO app_settings(key,value) VALUES($1,jsonb_build_object('chatId',$2::text,'at',now()))
          ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, [key,row.chat_id]);
      }
    }
    await this.db.query(`INSERT INTO app_settings(key,value) VALUES('outreach:reconcile-cursor',$1::jsonb)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify({ after: rows.length === limit ? rows.at(-1)!.chat_id : null })]);
  }

  async reconcileChat(chatId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM chats WHERE id=$1 FOR UPDATE', [chatId]);
      await tx.query('SELECT id FROM tickets WHERE chat_id=$1 FOR UPDATE', [chatId]);
      const i = (await tx.query('SELECT * FROM outreach_telegram_inputs WHERE chat_id=$1', [chatId])).rows[0];
      if (!i) return;
      const previous = (await tx.query(`SELECT s.id,s.source_revision,rs.relationship_id,rs.enrollment_state
        FROM outreach_source_threads s JOIN outreach_relationship_sources rs ON rs.source_thread_id=s.id WHERE s.chat_id=$1`, [chatId])).rows[0];
      const isEligible = i.inclusion === 'included' && !i.is_control && i.tracking_state === 'active' && i.mapping_status !== 'non_company';
      const key = i.company_id ? `company:${i.company_id}` : `prospect:${i.ticket_id}`;
      // A previously unknown, pending prospect can acquire its first confirmed
      // company without losing its relationship ID. Published merges come later.
      if (previous && i.company_id && !(await tx.query('SELECT id FROM outreach_relationships WHERE identity_key=$1', [key])).rows.length) {
        await tx.query(`UPDATE outreach_relationships SET identity_key=$1,company_id=$2,kind='company',display_name=$4,identity_version=identity_version+1
          WHERE id=$3 AND kind='contact_prospect'`, [key, i.company_id, previous.relationship_id,i.canonical_name||i.title]);
      }
      const r = (await tx.query(`INSERT INTO outreach_relationships(identity_key,kind,company_id,display_name,summary,workstream)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(identity_key) DO UPDATE SET
        display_name=CASE WHEN outreach_relationships.identity_version>0 THEN outreach_relationships.display_name ELSE EXCLUDED.display_name END,summary=EXCLUDED.summary,workstream=EXCLUDED.workstream,retained=true
        RETURNING id`, [key, i.company_id ? 'company' : 'contact_prospect', i.company_id,
        i.canonical_name || i.title || 'Unnamed contact', '', i.workstream])).rows[0]!;
      const source = (await tx.query(`INSERT INTO outreach_source_threads(kind,source_key,chat_id,ticket_id,source_revision,observed_at,reconciled_at)
        VALUES('telegram',$1,$2,$3,$4,$5,$6) ON CONFLICT(source_key) DO UPDATE SET
        source_revision=EXCLUDED.source_revision,observed_at=EXCLUDED.observed_at,reconciled_at=EXCLUDED.reconciled_at RETURNING id`,
      [`telegram:${chatId}`, chatId, i.ticket_id, i.source_revision, i.latest_source_at, this.clock.now().toISOString()])).rows[0]!;
      const changedIdentity = previous && previous.relationship_id !== r.id;
      const state = !isEligible ? 'suspended' : !previous || changedIdentity || previous.enrollment_state === 'suspended' ? 'pending' : previous.enrollment_state;
      await tx.query(`INSERT INTO outreach_relationship_sources(source_thread_id,relationship_id,enrollment_state) VALUES($1,$2,$3)
        ON CONFLICT(source_thread_id) DO UPDATE SET relationship_id=EXCLUDED.relationship_id,enrollment_state=EXCLUDED.enrollment_state,
        generation=outreach_relationship_sources.generation+CASE WHEN outreach_relationship_sources.relationship_id<>EXCLUDED.relationship_id THEN 1 ELSE 0 END,
        version=outreach_relationship_sources.version+CASE WHEN outreach_relationship_sources.relationship_id<>EXCLUDED.relationship_id OR outreach_relationship_sources.enrollment_state<>EXCLUDED.enrollment_state THEN 1 ELSE 0 END,
        updated_at=EXCLUDED.updated_at`, [source.id, r.id, state]);
      if (!previous || previous.source_revision !== i.source_revision || changedIdentity || previous.enrollment_state !== state) {
        for (const id of [...new Set([String(r.id), ...(previous ? [String(previous.relationship_id)] : [])])].sort()) {
          await tx.query(`UPDATE outreach_relationships SET evidence_revision=evidence_revision+1,updated_at=$2 WHERE id=$1`, [id, this.clock.now().toISOString()]);
          if ((await tx.query("SELECT to_regclass(quote_ident(current_schema())||'.outreach_detail_refresh') AS name")).rows[0]?.name) {
            await tx.query(`INSERT INTO outreach_detail_refresh(relationship_id,reason)
              SELECT id,'Synchronize current approved conversation details; preserve the accepted sales stage'
              FROM outreach_relationships WHERE id=$1 AND accepted_stage IS NOT NULL
              ON CONFLICT(relationship_id) DO UPDATE SET reason=EXCLUDED.reason,revision=gen_random_uuid(),updated_at=now()`, [id]);
          }
        }
      }
      if (changedIdentity) await tx.query(`UPDATE outreach_relationships SET retained=false WHERE id=$1 AND accepted_stage IS NULL
        AND NOT EXISTS(SELECT 1 FROM outreach_relationship_sources WHERE relationship_id=$1)`, [previous.relationship_id]);
    });
  }

  async list(raw: OutreachListInput) {
    const input = outreachListSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const rows = (await tx.query(`SELECT r.* FROM outreach_relationships r WHERE r.retained
        AND ($1::uuid IS NULL OR r.id>$1) AND ($2::text IS NULL OR strpos(lower(r.display_name),lower($2))>0)
        AND EXISTS(SELECT 1 ${joins} WHERE rs.relationship_id=r.id AND ${eligible} AND ${identityMatches})
        AND ($3::text IS NULL OR coalesce(r.accepted_stage,r.provisional_stage)=$3)
        ORDER BY r.id LIMIT $4`, [input.cursor ?? null, input.query || null, input.stage ?? null, input.limit + 1])).rows;
      const page = rows.slice(0, input.limit);
      const ids = page.map((row) => row.id);
      // Hydrate a page in two bounded round trips. Per-card queries multiply WAN
      // latency when PostgreSQL is reached through Supabase's session pooler.
      const linked = ids.length ? (await tx.query(`SELECT rs.relationship_id,rs.enrollment_state,s.observed_at,s.reconciled_at,s.source_revision,i.next_action,
        EXISTS(SELECT 1 FROM messages m JOIN telegram_account a ON a.self_user_id=m.sender_id WHERE m.chat_id=s.chat_id AND m.deleted_at IS NULL) AS has_outbound,
        CASE WHEN s.kind='telegram' THEN i.source_revision ELSE s.source_revision END AS current_revision,
        (${eligible} AND (s.kind<>'telegram' OR (i.mapping_status<>'non_company' AND i.company_id IS NOT DISTINCT FROM r.company_id))) AS eligible
        ${joins} JOIN outreach_relationships r ON r.id=rs.relationship_id WHERE rs.relationship_id=ANY($1::uuid[])`, [ids])).rows : [];
      const actionsTable = (await tx.query("SELECT to_regclass(quote_ident(current_schema())||'.outreach_actions') AS name")).rows[0]?.name;
      const actions = actionsTable && ids.length ? (await tx.query(`SELECT DISTINCT ON (relationship_id) relationship_id,text FROM outreach_actions
        WHERE relationship_id=ANY($1::uuid[]) AND actor='antseed' AND state='open'
        ORDER BY relationship_id,local_date NULLS LAST,instant NULLS LAST,id`, [ids])).rows : [];
      const items = page.map((row) => this.relationshipFromRows(row,
        linked.filter((source) => String(source.relationship_id) === String(row.id)),
        actions.find((action) => String(action.relationship_id) === String(row.id))?.text));
      return { items: items.filter((r) => (!input.stage || r.displayStage === input.stage) && (!input.disposition || r.disposition === input.disposition)),
        nextCursor: rows.length > input.limit ? String(page.at(-1)!.id) : null };
    });
  }

  private async relationship(tx: SqlExecutor, r: Row): Promise<OutreachRelationship> {
    const linked = (await tx.query(`SELECT rs.enrollment_state,s.observed_at,s.reconciled_at,s.source_revision,i.next_action,EXISTS(SELECT 1 FROM messages m JOIN telegram_account a ON a.self_user_id=m.sender_id WHERE m.chat_id=s.chat_id AND m.deleted_at IS NULL) AS has_outbound,CASE WHEN s.kind='telegram' THEN i.source_revision ELSE s.source_revision END AS current_revision,
      (${eligible} AND (s.kind<>'telegram' OR (i.mapping_status<>'non_company' AND i.company_id IS NOT DISTINCT FROM $2::uuid))) AS eligible
      ${joins} WHERE rs.relationship_id=$1`, [r.id, r.company_id])).rows;
    const actionsTable = (await tx.query("SELECT to_regclass(quote_ident(current_schema())||'.outreach_actions') AS name")).rows[0]?.name;
    const action = actionsTable ? (await tx.query("SELECT text FROM outreach_actions WHERE relationship_id=$1 AND actor='antseed' AND state='open' ORDER BY local_date NULLS LAST,instant NULLS LAST,id LIMIT 1", [r.id])).rows[0]?.text : null;
    return this.relationshipFromRows(r, linked, action);
  }

  private relationshipFromRows(r: Row, linked: Row[], action: unknown): OutreachRelationship {
    // Assess the complete source set before hiding ineligible context. Excluding
    // even one contributor invalidates its saved assessment immediately.
    const current = linked.length > 0 && linked.every((s) => s.enrollment_state==='rejected' || (s.enrollment_state==='suspended' ? !s.eligible : s.eligible && s.source_revision === s.current_revision));
    const sources = linked.filter((s) => s.eligible && !['suspended', 'rejected'].includes(String(s.enrollment_state)));
    const provisional = current && r.provisional_evidence_revision === r.evidence_revision ? r.provisional_stage : null;
    const accepted = r.accepted_stage as OutreachRelationship['acceptedStage'];
    const stage = accepted ?? provisional as OutreachRelationship['displayStage'];
    const knownAction=(typeof action === 'string' ? action : null)||sources.find(s=>s.enrollment_state==='active'&&s.next_action)?.next_action||(accepted==='lead'?(sources.some(s=>s.has_outbound)?'Follow up on the first enquiry':'Make initial contact'):null);
    const latest = (name: string) => sources.map((s) => nullableIso(s[name])).filter((v): v is string => !!v).sort().at(-1) ?? null;
    return { id: String(r.id), kind: r.kind as OutreachRelationship['kind'], companyId: r.company_id as string | null,
      displayName: String(r.display_name), title: `${r.display_name} — ${knownAction || (accepted ? 'Next action not recorded' : 'Review initial placement')}`,
      // Shared company summaries can contain excluded/pending-source claims.
      // M1 has no provenance-bound accepted aggregate summary writer yet.
      summary: '', workstream: r.workstream as OutreachRelationship['workstream'], acceptedStage: accepted,
      displayStage: stage, stageBasis: accepted ? 'accepted' : provisional ? 'provisional' : 'unknown',
      stageReason: provisional ? r.provisional_reason as string | null : null,
      stageVersion: Number(r.stage_version), evidenceRevision: Number(r.evidence_revision), identityVersion:Number(r.identity_version),actionsVersion:Number(r.actions_version),
      disposition: stage ? 'pipeline' : 'context_review', sourceCount: sources.length,
      pendingSourceCount: sources.filter((s) => s.enrollment_state === 'pending').length,
      latestSourceAt: latest('observed_at'), reconciledAt: latest('reconciled_at'), sourceState: current ? 'current' : 'changed' };
  }

  async get(id: string): Promise<OutreachDetail> {
    outreachGetSchema.parse({ id });
    return this.db.transaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const r = (await tx.query('SELECT * FROM outreach_relationships WHERE id=$1 AND retained', [id])).rows[0];
      if (!r) throw new DomainError('not_found', 'Outreach relationship not found');
      const rows = (await tx.query(`SELECT i.*,s.id,s.kind AS source_kind,s.source_revision,s.coverage,s.observed_at,rs.enrollment_state ${joins}
        WHERE rs.relationship_id=$1 ORDER BY s.id`, [id])).rows;
      const activeSources: OutreachSourceContext[] = [], pendingSources: OutreachSourceContext[] = [], suspendedSources: OutreachSource[] = [];
      for (const row of rows) {
        if (row.source_kind === 'email_report') {
          const raw=(await tx.query('SELECT * FROM outreach_report_context WHERE source_id=$1',[row.id])).rows[0];
          if(!raw)continue;
          const c=raw.context as {contacts:Array<{name:string;role:string;email?:string}>;claims:string[];sourceUrl?:string;summary:string;nextAction:string};
          const isEligible=(row.coverage as {superseded?:boolean}).superseded!==true;
          const source:OutreachSourceContext={id:String(row.id),kind:'email_report',chatId:null,ticketId:null,title:String(raw.title),operationalLane:null,enrollmentState:row.enrollment_state as OutreachSource['enrollmentState'],eligible:isEligible,sourceRevision:String(row.source_revision),latestSourceAt:nullableIso(row.observed_at),contacts:c.contacts.map((p,n)=>({id:`report:${row.id}:contact:${n}`,names:[p.name],usernames:[],roles:p.role?[p.role]:[],affiliation:'external',emails:p.email?[p.email]:[],phones:[],evidenceIds:c.claims.map((_,k)=>`report:${row.id}:claim:${k}`)})),facts:[],evidence:c.claims.map((excerpt,n)=>({id:`report:${row.id}:claim:${n}`,excerpt,sourceUrl:c.sourceUrl??null,observedAt:nullableIso(row.observed_at)??''})),coverage:{evidenceLimit:100,factLimit:100,truncated:false,reportCheckedAt:String((row.coverage as {checkedAt?:string}).checkedAt??''),description:String((row.coverage as {description?:string}).description??'')},reportSummary:c.summary,reportNextAction:c.nextAction};
          if(!isEligible||['suspended','rejected'].includes(source.enrollmentState))suspendedSources.push(source);else (source.enrollmentState==='active'?activeSources:pendingSources).push(source);
          continue;
        }
        const isEligible = row.inclusion === 'included' && !row.is_control && row.tracking_state === 'active' && row.mapping_status !== 'non_company' && row.company_id === r.company_id;
        const source: OutreachSource = { id: String(row.id), kind: 'telegram', chatId: String(row.chat_id), ticketId: String(row.ticket_id), title: String(row.title),
          operationalLane: row.lane as OutreachSource['operationalLane'],nextAction:row.next_action as string|null,hasOutbound:!!(await tx.query('SELECT 1 FROM messages m JOIN telegram_account a ON a.self_user_id=m.sender_id WHERE m.chat_id=$1 AND m.deleted_at IS NULL LIMIT 1',[String(row.chat_id)])).rowCount, enrollmentState: row.enrollment_state as OutreachSource['enrollmentState'],
          eligible: isEligible, sourceRevision: String(row.source_revision), latestSourceAt: nullableIso(row.latest_source_at) };
        if (!isEligible || source.enrollmentState === 'suspended' || source.enrollmentState === 'rejected') { suspendedSources.push(source); continue; }
        const context = await this.context(tx, source, r.company_id as string | null);
        (source.enrollmentState === 'active' ? activeSources : pendingSources).push(context);
      }
      const extended=!!(await tx.query("SELECT to_regclass(quote_ident(current_schema())||'.outreach_actions') AS name")).rows[0]?.name;
      const actions=extended?(await tx.query('SELECT a.*,a.local_date::text AS local_date FROM outreach_actions a WHERE a.relationship_id=$1 ORDER BY a.local_date NULLS LAST,a.instant NULLS LAST,a.id',[id])).rows.map(a=>({id:String(a.id),text:String(a.text),actor:a.actor as 'antseed'|'external'|'unknown',state:a.state as 'open'|'completed'|'cancelled',precision:a.precision as 'none'|'date'|'instant',localDate:a.local_date as string|null,instant:nullableIso(a.instant),timezone:String(a.timezone),version:Number(a.version)})):[];
      const published=extended?(await tx.query('SELECT state,last_error,observed_stage FROM outreach_task_bindings WHERE relationship_id=$1',[id])).rows[0]:null;
      return {actions,publication:published?{state:String(published.state),lastError:published.last_error as string|null,observedStage:published.observed_stage as string|null}:null, relationship: await this.relationship(tx, r), activeSources, pendingSources, suspendedSources,
        limits: ['Pending source context does not contribute until its sales enrollment decision is approved.', 'Email-report claims are not original authenticated mailbox messages.', 'Operational lanes do not establish commercial stages.'] };
    });
  }

  private async context(tx: SqlExecutor, source: OutreachSource, companyId: string | null): Promise<OutreachSourceContext> {
    const evidence = (await tx.query(`SELECT e.*,m.sender_id,m.sender_snapshot,m.forward_metadata,m.sent_at,(SELECT self_user_id FROM telegram_account LIMIT 1) AS self_id FROM evidence e JOIN messages m ON m.chat_id=e.chat_id AND m.id=e.message_id
      WHERE e.chat_id=$1 AND e.invalidated_at IS NULL AND m.deleted_at IS NULL AND e.message_version=m.version ORDER BY e.observed_at DESC,e.id LIMIT 101`, [source.chatId])).rows;
    const ids = evidence.slice(0, 100).map((e) => String(e.id));
    const people = (await tx.query(`SELECT DISTINCT p.* FROM contacts p JOIN ticket_contacts tc ON tc.contact_id=p.id
      WHERE tc.ticket_id=$1 AND EXISTS(SELECT 1 FROM contact_evidence ce WHERE ce.contact_id=p.id AND ce.evidence_id=ANY($2::uuid[])) ORDER BY p.id`, [source.ticketId, ids])).rows;
    const contacts: OutreachContact[] = [];
    for (const p of people) {
      const roles = (await tx.query<{ role: string }>(`SELECT r.role FROM contact_company_roles r WHERE r.contact_id=$1 AND r.company_id=$2
        AND EXISTS(SELECT 1 FROM role_evidence re WHERE re.role_id=r.id AND re.evidence_id=ANY($3::uuid[])) ORDER BY r.role`, [p.id, companyId, ids])).rows;
      const personEvidence = (await tx.query<{ evidence_id: string }>('SELECT evidence_id FROM contact_evidence WHERE contact_id=$1 AND evidence_id=ANY($2::uuid[]) ORDER BY evidence_id', [p.id, ids])).rows;
      contacts.push({ id: String(p.id), names: p.names as string[], usernames: p.usernames as string[], affiliation: p.affiliation as OutreachContact['affiliation'], emails:p.emails as string[],phones:p.phones as string[],roles: roles.map((r) => r.role), evidenceIds: personEvidence.map((e) => e.evidence_id) });
    }
    const facts = (await tx.query(`SELECT f.* FROM facts f WHERE f.ticket_id=$1 AND f.parent_fact_id IS NULL
      AND EXISTS(SELECT 1 FROM fact_evidence fe WHERE fe.fact_id=f.id)
      AND NOT EXISTS(SELECT 1 FROM fact_evidence fe WHERE fe.fact_id=f.id AND NOT(fe.evidence_id=ANY($2::uuid[])))
      ORDER BY f.id LIMIT 101`, [source.ticketId, ids])).rows;
    const selectedFacts = facts.slice(0, 100);
    const hydrated = await factRows(tx, selectedFacts);
    const dates = selectedFacts.length ? (await tx.query(`SELECT d.*,d.local_date::text AS local_date FROM facts d WHERE d.parent_fact_id=ANY($1::uuid[])
        AND EXISTS(SELECT 1 FROM fact_evidence fe WHERE fe.fact_id=d.id)
        AND NOT EXISTS(SELECT 1 FROM fact_evidence fe WHERE fe.fact_id=d.id AND NOT(fe.evidence_id=ANY($2::uuid[])))
        ORDER BY d.id`, [selectedFacts.map((f) => f.id), ids])).rows : [];
    const citations = dates.length ? (await tx.query<{ fact_id: string; evidence_id: string }>(
      'SELECT fact_id,evidence_id FROM fact_evidence WHERE fact_id=ANY($1::uuid[]) ORDER BY fact_id,evidence_id', [dates.map((d) => d.id)])).rows : [];
    for (const full of hydrated) {
      full.dates = dates.filter((d) => String(d.parent_fact_id) === full.id).map((d): DateFact => ({ kind: d.kind as DateFact['kind'], originalText: String(d.text),
        relativeTo: iso(d.relative_to), timezone: String(d.timezone), resolvedAt: nullableIso(d.resolved_at),
        localDate: d.local_date == null ? null : String(d.local_date), precision: d.date_precision as DateFact['precision'],
        ambiguous: Boolean(d.ambiguous), evidenceIds: citations.filter((c) => c.fact_id === d.id).map((c) => c.evidence_id) }));
    }
    return { ...source, contacts, facts: hydrated,
      evidence: evidence.slice(0, 100).map((e) => ({ id: String(e.id), excerpt: String(e.excerpt), sourceUrl: e.source_url as string | null, observedAt: nullableIso(e.observed_at)!,sentAt:iso(e.sent_at),author:{id:e.sender_id==null?null:String(e.sender_id),party:e.sender_id!=null&&String(e.sender_id)===String(e.self_id)?'antseed' as const:'unknown' as const,names:(e.sender_snapshot as {names?:string[]})?.names??[]},forward:e.forward_metadata as import('../shared/domain.js').ForwardProvenance })),
      coverage: { evidenceLimit: 100, factLimit: 100, truncated: evidence.length > 100 || facts.length > 100 } };
  }
}
