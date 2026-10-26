import { AsyncResource } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Database, RuntimeConfig } from '../shared/ports.js';
import { DomainError } from '../shared/api.js';
import { SALES_STAGES, type SalesStage, type OutreachDetail } from '../shared/outreach-domain.js';
import type { OutreachWorkflow } from './service.js';
import { digest } from './hash.js';
import { redactionCard, reviewCard, salesCard } from './card-format.js';
import type { Row } from '../workflow/sql.js';
type Board = {
    projectId: number;
    viewId: number;
    buckets: Record<SalesStage, number>;
};
const obj = (v: unknown): Row => {
    if (!v || typeof v !== 'object' || Array.isArray(v))
        throw new DomainError('upstream_unavailable', 'Invalid Vikunja response');
    return v as Row;
};
const positive = (v: unknown) => {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 1)
        throw new DomainError('upstream_unavailable', 'Invalid Vikunja identifier');
    return n;
};
/** Dedicated commercial projection. Never reads/writes operational board bindings. */
export class OutreachPublisher {
    private token: string | null;
    private readonly receiptScope = new AsyncResource('antseed-outreach-receipts');
    constructor(private db: Database, private config: RuntimeConfig['vikunja'], private workflow: OutreachWorkflow, private fetcher: typeof fetch = fetch) { this.token = config.apiToken; }
    private async auth(signal: AbortSignal) {
        if (this.token)
            return;
        if (!this.config.password)
            throw new DomainError('not_configured', 'Vikunja login is not configured');
        const r = await this.fetcher(`${this.config.baseUrl}/api/v2/login`, { method: 'POST', redirect: 'error', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: this.config.username, password: this.config.password }) });
        if (!r.ok) {
            await r.body?.cancel();
            throw new DomainError('upstream_unavailable', `Vikunja login HTTP ${r.status}`, true);
        }
        this.token = String(obj(await r.json()).token ?? '');
        if (!this.token)
            throw new DomainError('upstream_unavailable', 'Vikunja login has no token');
    }
    private signal(signal?: AbortSignal) { return AbortSignal.any([AbortSignal.timeout(this.config.timeoutMs ?? 45000), ...(signal ? [signal] : [])]); }
    async read(path: string, signal?: AbortSignal): Promise<unknown> {
        const s = this.signal(signal);
        await this.auth(s);
        const r = await this.fetcher(`${this.config.baseUrl}/api/v2${path}`, { headers: { Authorization: `Bearer ${this.token}` }, signal: s, redirect: 'error' });
        if (r.status === 401) {
            this.token = this.config.apiToken;
            await r.body?.cancel();
            throw new DomainError('upstream_unavailable', 'Vikunja credential expired; retry read', true);
        }
        if (r.status === 404) {
            await r.body?.cancel();
            return null;
        }
        if (!r.ok) {
            await r.body?.cancel();
            throw new DomainError('upstream_unavailable', `Vikunja read HTTP ${r.status}`, true);
        }
        return r.json();
    }
    private async list(path: string, signal?: AbortSignal): Promise<Row[]> {
        const all: Row[] = [];
        for (let p = 1; p <= 1000; p++) {
            const r = obj(await this.read(`${path}${path.includes('?') ? '&' : '?'}page=${p}&per_page=100`, signal));
            if (!Array.isArray(r.items))
                throw new DomainError('upstream_unavailable', 'Vikunja list lacks items');
            all.push(...r.items.map(obj));
            if (!r.items.length || p >= Number(r.total_pages))
                return all;
        }
        throw new DomainError('conflict', 'Vikunja pagination exceeds bounded board scan');
    }
    /** Receipt append is detached from a lost lock's permanently fenced SQL scope.
     * It cannot accept a business decision or release its resource guard. */
    private async receipt(id: string, status: number, body: unknown) {
        const values = [id, status, JSON.stringify(body)];
        const sql = 'INSERT INTO outreach_remote_receipts(request_id,status,body) VALUES($1,$2,$3) ON CONFLICT DO NOTHING';
        try {
            // Healthy calls reuse their held session, including at full pool capacity.
            await this.db.query(sql, values);
        }
        catch {
            // Only the immutable receipt append escapes a lost/fenced scope.
            await this.receiptScope.runInAsyncScope(() => this.db.query(sql, values));
        }
    }
    async settle(resource: string): Promise<void> {
        const q = (await this.db.query(`SELECT q.*,r.status AS receipt_status,r.body AS receipt_body FROM outreach_remote_requests q LEFT JOIN outreach_remote_receipts r ON r.request_id=q.id WHERE q.resource_key=$1 AND q.state IN ('prepared','dispatched','remote_unresolved')`, [resource])).rows[0];
        if (!q)
            return;
        if (q.state === 'prepared') { // No dispatch record means no network operation was authorized.
            await this.db.query("UPDATE outreach_remote_requests SET state='conflict',last_error='Prepared request retired before dispatch' WHERE id=$1 AND state='prepared'", [q.id]);
            return;
        }
        if (q.receipt_status == null)
            throw new DomainError('upstream_unavailable', `Publication quarantined: request ${q.id} has no terminal response. Readback alone cannot release it.`, false);
        await this.db.query(`UPDATE outreach_remote_requests SET state='verified',response_status=$2,response_body=$3,terminal_at=now(),last_error=NULL WHERE id=$1 AND state IN ('dispatched','remote_unresolved')`, [q.id, q.receipt_status, JSON.stringify(q.receipt_body)]);
    }
    private async write(resource: string, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body: unknown, signal: AbortSignal, publicationId: string | null = null): Promise<unknown> {
        signal.throwIfAborted();
        await this.settle(resource);
        await this.auth(this.signal(signal));
        signal.throwIfAborted();
        const id = randomUUID();
        await this.db.query('INSERT INTO outreach_remote_requests(id,resource_key,publication_id,method,path,body) VALUES($1,$2,$3,$4,$5,$6)', [id, resource, publicationId, method, path, JSON.stringify(body)]);
        // Persist the barrier before dispatch. No retry follows an unknown outcome.
        await this.db.query("UPDATE outreach_remote_requests SET state='dispatched',dispatched_at=now() WHERE id=$1 AND state='prepared'", [id]);
        try {
            const r = await this.fetcher(`${this.config.baseUrl}/api/v2${path}`, { method, redirect: 'error', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json' }, ...(body == null ? {} : { body: JSON.stringify(body) }), signal: this.signal(signal) });
            let response: unknown = null;
            // Receiving a terminal HTTP response suffices to record completion even if
            // its JSON is malformed; no raw upstream error body is persisted/reflected.
            if (r.ok && r.status !== 204) {
                try {
                    response = await r.json();
                }
                catch {
                    response = null;
                }
            }
            else
                await r.body?.cancel();
            await this.receipt(id, r.status, response);
            signal.throwIfAborted();
            await this.settle(resource);
            if (r.status === 401)
                this.token = this.config.apiToken;
            if (!r.ok && !(method === 'PATCH' && r.status === 304) && !(method === 'DELETE' && r.status === 404))
                throw new DomainError('upstream_unavailable', `Vikunja publication HTTP ${r.status}`, r.status >= 500 || r.status === 429);
            return response;
        }
        catch (e) {
            // A timeout/abort/session loss proves neither cancellation nor non-execution.
            await this.db.query("UPDATE outreach_remote_requests SET state='remote_unresolved',last_error='No durable terminal response; resource quarantined' WHERE id=$1 AND state='dispatched'", [id]).catch(() => { });
            throw e instanceof DomainError ? e : new DomainError('upstream_unavailable', `Vikunja outcome unknown; inspect publication request ${id}`, false);
        }
    }
    async ensureBoard(signal?: AbortSignal): Promise<Board> {
        return this.db.withSessionLock('antseed:outreach:board', async (_sql, session) => {
            const s = AbortSignal.any([session, ...(signal ? [signal] : [])]), resource = 'outreach:board';
            await this.settle(resource);
            const b = (await this.db.query('SELECT * FROM outreach_board_binding WHERE singleton')).rows[0]!;
            const marker = `[antseed-outreach-board:${b.namespace}]`;
            let project = b.project_id ? await this.read(`/projects/${b.project_id}`, s) : null;
            if (!project) {
                const matches = (await this.list('/projects', s)).filter(p => String(p.description ?? '').includes(marker));
                if (matches.length > 1)
                    throw new DomainError('conflict', 'Duplicate managed Outreach projects');
                project = matches[0] ?? await this.write(resource, 'POST', '/projects', { title: 'AntSeed Outreach', description: marker }, s);
            }
            const p = obj(project), projectId = positive(p.id);
            if (!String(p.description ?? '').includes(marker))
                throw new DomainError('conflict', 'Outreach project marker changed');
            await this.db.query('UPDATE outreach_board_binding SET project_id=$1 WHERE singleton', [projectId]);
            const views = await this.list(`/projects/${projectId}/views`, s);
            let v = views.find(v => Number(v.id) === Number(b.view_id)) ?? views.find(v => v.view_kind === 'kanban' && v.bucket_configuration_mode === 'manual');
            v ??= obj(await this.write(resource, 'POST', `/projects/${projectId}/views`, { title: 'Sales pipeline', view_kind: 'kanban', bucket_configuration_mode: 'manual' }, s));
            const viewId = positive(v.id), root = `/projects/${projectId}/views/${viewId}`;
            if (v.view_kind !== 'kanban' || v.bucket_configuration_mode !== 'manual')
                throw new DomainError('conflict', 'Outreach requires a manual Kanban view');
            await this.db.query('UPDATE outreach_board_binding SET view_id=$1 WHERE singleton', [viewId]);
            const existing = await this.list(`${root}/buckets`, s), buckets = {} as Board['buckets'];
            const defaults: Record<string, string> = { lead: 'To-Do', qualification: 'Doing', won: 'Done' };
            for (const [n, stage] of SALES_STAGES.entries()) {
                const matches = existing.filter(x => x.title === stage.label);
                if (matches.length > 1)
                    throw new DomainError('conflict', 'Duplicate sales stage buckets');
                let bucket = matches[0] ?? existing.find(x => x.title === defaults[stage.id]);
                if (!bucket)
                    bucket = obj(await this.write(resource, 'POST', `${root}/buckets`, { title: stage.label, position: (n + 1) * 100, limit: 0 }, s));
                else if (bucket.title !== stage.label || Number(bucket.position) !== (n + 1) * 100)
                    bucket = obj(await this.write(resource, 'PUT', `${root}/buckets/${positive(bucket.id)}`, { ...bucket, title: stage.label, position: (n + 1) * 100, limit: 0 }, s));
                buckets[stage.id] = positive(bucket.id);
            }
            const final = await this.list(`${root}/buckets`, s);
            if (final.length !== 5 || final.some(x => !Object.values(buckets).includes(Number(x.id))))
                throw new DomainError('conflict', 'Unexpected buckets in managed Outreach project');
            if (Number(v.default_bucket_id) !== buckets.lead || Number(v.done_bucket_id) !== 0 || v.filter != null) {
                v = obj(await this.write(resource, 'PUT', root, { ...v, default_bucket_id: buckets.lead, done_bucket_id: 0, filter: null }, s));
            }
            if (Number(v.done_bucket_id) !== 0)
                throw new DomainError('conflict', 'Vikunja does not support neutral done semantics for this sales view');
            await this.db.query("UPDATE outreach_board_binding SET buckets=$1,state='ready',last_error=NULL WHERE singleton", [JSON.stringify(buckets)]);
            return { projectId, viewId, buckets };
        });
    }
    private async remoteTask(board: Board, taskId: number, signal: AbortSignal) {
        const t = await this.read(`/tasks/${taskId}`, signal);
        if (!t)
            return null;
        const task = obj(t);
        if (Number(task.project_id) !== board.projectId)
            throw new DomainError('conflict', 'Managed sales task moved to another project');
        const result = obj(await this.read(`/projects/${board.projectId}/views/${board.viewId}/buckets/tasks?filter=${encodeURIComponent(`id = ${taskId}`)}`, signal));
        const grouped = Array.isArray(result.items) ? result.items.map(obj) : [];
        const bucket = grouped.find(b => Array.isArray(b.tasks) && (b.tasks as Row[]).some(t => Number(t.id) === taskId));
        const stage = SALES_STAGES.find(st => board.buckets[st.id] === Number(bucket?.id))?.id;
        if (!stage)
            throw new DomainError('conflict', 'Sales task is outside the managed five-stage view');
        return { task, stage };
    }
    private async maintain(binding:Row, work:()=>Promise<void>):Promise<void> {
        try { await work(); }
        catch(error) {
            const message=error instanceof DomainError?error.message:'Sales maintenance interrupted; durable request state retained';
            await this.db.query("UPDATE outreach_task_bindings SET state=CASE WHEN $3 THEN 'conflict' ELSE state END,last_error=$2,updated_at=now() WHERE relationship_id=$1",[binding.relationship_id,message,error instanceof DomainError&&error.code==='conflict']).catch(()=>{});
        }
    }
    private async redactOne(board: Board, signal?: AbortSignal): Promise<Row | null> {
        const cursor = (await this.db.query("SELECT value FROM app_settings WHERE key='outreach:redaction-cursor'")).rows[0]?.value as {
            after?: string;
        } | undefined;
        const bindings = (await this.db.query("SELECT b.*,p.snapshot FROM outreach_task_bindings b JOIN outreach_publications p ON p.relationship_id=b.relationship_id AND p.snapshot_hash=b.published_hash AND p.state='published' WHERE b.task_id IS NOT NULL AND b.state NOT IN ('conflict','review_required') AND NOT EXISTS(SELECT 1 FROM outreach_remote_requests q WHERE q.resource_key='outreach:relationship:'||b.relationship_id::text AND q.state IN ('dispatched','remote_unresolved') AND NOT EXISTS(SELECT 1 FROM outreach_remote_receipts receipt WHERE receipt.request_id=q.id)) AND ($1::uuid IS NULL OR b.relationship_id>$1) ORDER BY b.relationship_id LIMIT 10", [cursor?.after ?? null])).rows;
        for (const binding of bindings) {
            signal?.throwIfAborted();
            const m = await this.workflow.manifest(this.db, String(binding.relationship_id));
            const previous = (binding.snapshot as {
                manifest: {
                    sources: Row[];
                };
            }).manifest.sources.filter(s => s.enrollment_state === 'active');
            if (previous.every(old => m.value.sources.some(s => s.id === old.id && s.eligible && s.enrollment_state === 'active' && s.current_revision === old.source_revision)))
                continue;
            const replacement = (await this.db.query("SELECT * FROM outreach_publications WHERE relationship_id=$1 AND state='pending' ORDER BY created_at DESC,id DESC LIMIT 1", [binding.relationship_id])).rows[0];
            if (replacement && digest((replacement.snapshot as {manifest:unknown}).manifest) === m.hash) {
                // Publish the already approved current snapshot in this same turn
                // instead of first issuing redundant redaction HTTP requests.
                return replacement;
            }
            await this.maintain(binding, () => this.db.withSessionLock(`antseed:outreach:relationship:${binding.relationship_id}`, async (_sql, scope) => {
                const s = AbortSignal.any([scope, ...(signal ? [signal] : [])]), resource = `outreach:relationship:${binding.relationship_id}`;
                await this.settle(resource);
                const current = await this.workflow.manifest(this.db, String(binding.relationship_id));
                if (previous.every(old => current.value.sources.some(x => x.id === old.id && x.eligible && x.enrollment_state === 'active' && x.current_revision === old.source_revision)))
                    return;
                const task = await this.remoteTask(board, positive(binding.task_id), s);
                if (!task)
                    return;
                const marker = `[antseed-relationship:${binding.relationship_id}]`, generation = `[antseed-projection:${binding.relationship_id}:g${binding.generation}]`;
                if (!String(task.task.description ?? '').includes(generation))
                    throw new DomainError('conflict', 'Cannot redact a sales task without its exact managed marker');
                const snapshot = binding.snapshot as OutreachDetail;
                const { title, description } = redactionCard(snapshot.relationship.displayName, snapshot.relationship.acceptedStage, marker, generation);
                if (task.task.title !== title || task.task.description !== description)
                    await this.write(resource, 'PATCH', `/tasks/${positive(task.task.id)}`, { title, description }, s);
                const verified = await this.remoteTask(board, positive(task.task.id), s);
                if (!verified || verified.task.description !== description)
                    throw new DomainError('conflict', 'Source redaction was not verified');
                await this.db.query("UPDATE outreach_task_bindings SET state='review_required',last_error='Published source context changed; descriptive claims redacted',updated_at=now() WHERE relationship_id=$1", [binding.relationship_id]);
            }));
        }
        await this.db.query("INSERT INTO app_settings(key,value) VALUES('outreach:redaction-cursor',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify({ after: bindings.length === 10 ? bindings.at(-1)!.relationship_id : null })]);
        return null;
    }
    /** Keep unplaced relationships visible without accepting a stage or publishing unapproved claims. */
    private async reviewOne(board: Board, signal?: AbortSignal): Promise<void> {
        const row = (await this.db.query(`SELECT r.id FROM outreach_relationships r
          LEFT JOIN outreach_task_bindings b ON b.relationship_id=r.id
          WHERE r.retained AND r.accepted_stage IS NULL AND coalesce(b.state,'pending')<>'conflict'
            AND EXISTS(SELECT 1 FROM outreach_relationship_sources rs JOIN outreach_source_threads src ON src.id=rs.source_thread_id
              LEFT JOIN chats c ON c.id=src.chat_id LEFT JOIN tickets t ON t.id=src.ticket_id
              WHERE rs.relationship_id=r.id AND rs.enrollment_state IN ('active','pending') AND
              ((src.kind='email_report' AND coalesce(src.coverage->>'superseded','false')<>'true') OR
               (src.kind='telegram' AND c.inclusion='included' AND NOT c.is_control AND t.tracking_state='active'
                AND c.mapping_status<>'non_company' AND t.company_id IS NOT DISTINCT FROM r.company_id)))
            AND NOT EXISTS(SELECT 1 FROM outreach_remote_requests q WHERE q.resource_key='outreach:relationship:'||r.id::text
              AND q.state IN ('dispatched','remote_unresolved') AND NOT EXISTS(SELECT 1 FROM outreach_remote_receipts receipt WHERE receipt.request_id=q.id))
          ORDER BY b.updated_at NULLS FIRST,r.id LIMIT 1`)).rows[0];
        if (!row) return;
        await this.maintain({relationship_id:row.id}, () => this.db.withSessionLock(`antseed:outreach:relationship:${row.id}`, async (_sql, scope) => {
            const s = AbortSignal.any([scope,...(signal ? [signal] : [])]), resource = `outreach:relationship:${row.id}`;
            await this.settle(resource);
            const current = await this.workflow.manifest(this.db,String(row.id));
            if (current.r.accepted_stage || !current.eligible.length) return;
            await this.db.query('INSERT INTO outreach_task_bindings(relationship_id) VALUES($1) ON CONFLICT DO NOTHING',[row.id]);
            const binding = (await this.db.query('SELECT * FROM outreach_task_bindings WHERE relationship_id=$1',[row.id])).rows[0]!;
            const marker = `[antseed-projection:${row.id}:g${binding.generation}]`;
            const { title, description } = reviewCard(String(current.r.display_name), String(row.id), marker, current.eligible.length);
            let task = binding.task_id ? await this.remoteTask(board,positive(binding.task_id),s) : null;
            if (binding.task_id && !task) throw new DomainError('conflict','Managed review card was deleted; explicit recovery is required');
            if (!task) {
                const matches = (await this.list(`/projects/${board.projectId}/tasks`,s)).filter(t=>String(t.description ?? '').includes(marker));
                if (matches.length>1) throw new DomainError('conflict','Duplicate sales review projection markers');
                const found = matches[0] ?? obj(await this.write(resource,'POST',`/projects/${board.projectId}/tasks`,{title,description},s));
                await this.db.query('UPDATE outreach_task_bindings SET task_id=$2 WHERE relationship_id=$1',[row.id,positive(found.id)]);
                task = await this.remoteTask(board,positive(found.id),s);
            }
            if (!task || !String(task.task.description ?? '').includes(marker)) throw new DomainError('conflict','Sales review marker is missing or changed');
            if (task.stage!=='lead') throw new DomainError('conflict','Unapproved review card was moved; a sales-stage approval is required');
            if ((await this.workflow.manifest(this.db,String(row.id))).hash!==current.hash) return;
            if (task.task.title!==title || task.task.description!==description) await this.write(resource,'PATCH',`/tasks/${positive(task.task.id)}`,{title,description},s);
            const verified = await this.remoteTask(board,positive(task.task.id),s);
            if (!verified || verified.task.title!==title || verified.task.description!==description || verified.stage!=='lead' || verified.task.done===true) throw new DomainError('conflict','Review card readback failed');
            await this.db.query("UPDATE outreach_task_bindings SET state='pending_review',observed_stage='lead',last_error=NULL,updated_at=now() WHERE relationship_id=$1",[row.id]);
        }));
    }
    private async retireOne(board: Board, signal?: AbortSignal): Promise<void> {
        const rows = (await this.db.query("SELECT b.* FROM outreach_task_bindings b JOIN outreach_relationships r ON r.id=b.relationship_id WHERE b.task_id IS NOT NULL AND b.state NOT IN ('retired','conflict') AND NOT EXISTS(SELECT 1 FROM outreach_remote_requests q WHERE q.resource_key='outreach:relationship:'||b.relationship_id::text AND q.state IN ('dispatched','remote_unresolved') AND NOT EXISTS(SELECT 1 FROM outreach_remote_receipts receipt WHERE receipt.request_id=q.id)) AND NOT EXISTS(SELECT 1 FROM outreach_relationship_sources rs JOIN outreach_source_threads s ON s.id=rs.source_thread_id LEFT JOIN chats c ON c.id=s.chat_id LEFT JOIN tickets t ON t.id=s.ticket_id WHERE rs.relationship_id=r.id AND (rs.enrollment_state='active' OR (r.accepted_stage IS NULL AND rs.enrollment_state='pending')) AND ((s.kind='email_report' AND coalesce(s.coverage->>'superseded','false')<>'true') OR (s.kind='telegram' AND c.inclusion='included' AND NOT c.is_control AND t.tracking_state='active' AND c.mapping_status<>'non_company' AND t.company_id IS NOT DISTINCT FROM r.company_id))) ORDER BY b.updated_at LIMIT 25")).rows;
        for (const binding of rows) {
            signal?.throwIfAborted();
            const current = await this.workflow.manifest(this.db, String(binding.relationship_id));
            if (current.eligible.some(s => s.enrollment_state === 'active' || (current.r.accepted_stage === null && s.enrollment_state === 'pending')))
                continue;
            await this.maintain(binding, () => this.db.withSessionLock(`antseed:outreach:relationship:${binding.relationship_id}`, async (_sql, scope) => {
                const s = AbortSignal.any([scope, ...(signal ? [signal] : [])]), resource = `outreach:relationship:${binding.relationship_id}`;
                await this.settle(resource);
                const latest = await this.workflow.manifest(this.db, String(binding.relationship_id));
                if (latest.eligible.some(x => x.enrollment_state === 'active' || (latest.r.accepted_stage === null && x.enrollment_state === 'pending'))) return;
                const task = await this.read(`/tasks/${binding.task_id}`, s);
                const marker = `[antseed-projection:${binding.relationship_id}:g${binding.generation}]`;
                if (task && Number(obj(task).project_id) !== board.projectId)
                    throw new DomainError('conflict', 'Retirement refused outside the managed Outreach project');
                if(task&&Array.isArray(obj(task).attachments)&&(obj(task).attachments as unknown[]).length)throw new DomainError('conflict','Preserve native attachments before retiring this managed sales card');
                if (task && !String(obj(task).description ?? '').includes(marker))
                    throw new DomainError('conflict', 'Retirement refused: managed projection marker is missing');
                await this.db.query(`INSERT INTO outreach_retirements(relationship_id,task_id,generation,reason,snapshot) VALUES($1,$2,$3,'All approved source contributions removed or remapped',$4) ON CONFLICT(task_id) DO NOTHING`, [binding.relationship_id, binding.task_id, binding.generation, JSON.stringify(task)]);
                if (task)
                    await this.write(resource, 'DELETE', `/tasks/${binding.task_id}`, null, s);
                if (await this.read(`/tasks/${binding.task_id}`, s))
                    throw new DomainError('conflict', 'Retired sales card still exists');
                await this.db.transaction(async (tx) => { await tx.query("UPDATE outreach_retirements SET state='retired',retired_at=now() WHERE task_id=$1", [binding.task_id]); await tx.query("UPDATE outreach_task_bindings SET task_id=NULL,generation=generation+1,state='retired',observed_stage=NULL,published_hash=NULL,last_error=NULL,updated_at=now() WHERE relationship_id=$1 AND task_id=$2", [binding.relationship_id, binding.task_id]); await tx.query("UPDATE outreach_publications SET state='superseded' WHERE relationship_id=$1 AND state='pending'", [binding.relationship_id]); });
            }));
            return;
        }
    }
    async tick(signal?: AbortSignal): Promise<void> {
        const b = (await this.db.query('SELECT mode FROM outreach_board_binding WHERE singleton')).rows[0];
        if (b?.mode !== 'publish')
            return;
        const saved = (await this.db.query('SELECT * FROM outreach_board_binding WHERE singleton')).rows[0]!;
        const board: Board = saved.state === 'ready' && saved.project_id && saved.view_id && Object.keys(saved.buckets as object).length === 5 ? { projectId: positive(saved.project_id), viewId: positive(saved.view_id), buckets: saved.buckets as Board['buckets'] } : await this.ensureBoard(signal);
        await this.retireOne(board, signal);
        const replacement = await this.redactOne(board, signal);
        const candidate = replacement ?? (await this.db.query(`SELECT p.* FROM outreach_publications p WHERE p.state='pending' AND NOT EXISTS(SELECT 1 FROM outreach_remote_requests q WHERE q.resource_key='outreach:relationship:'||p.relationship_id::text AND q.state IN ('dispatched','remote_unresolved') AND NOT EXISTS(SELECT 1 FROM outreach_remote_receipts r WHERE r.request_id=q.id)) ORDER BY p.created_at,p.id LIMIT 1`)).rows[0];
        if (!candidate) {
            await this.reviewOne(board, signal);
            return;
        }
        await this.db.withSessionLock(`antseed:outreach:relationship:${candidate.relationship_id}`, async (_sql, session) => {
            const s = AbortSignal.any([session, ...(signal ? [signal] : [])]), resource = `outreach:relationship:${candidate.relationship_id}`;
            try {
                await this.settle(resource);
                const p = (await this.db.query("SELECT * FROM outreach_publications WHERE id=$1 AND state='pending'", [candidate.id])).rows[0];
                if (!p)
                    return;
                const snapshot = p.snapshot as OutreachDetail & {
                    manifest: unknown;
                    restoreNative?: boolean;
                };
                const current = await this.workflow.manifest(this.db, String(p.relationship_id));
                if (digest(current.value) !== digest(snapshot.manifest))
                    throw new DomainError('conflict', 'Accepted sales snapshot changed; review current sources before publishing');
                await this.db.query('INSERT INTO outreach_task_bindings(relationship_id) VALUES($1) ON CONFLICT DO NOTHING', [p.relationship_id]);
                const binding = (await this.db.query('SELECT * FROM outreach_task_bindings WHERE relationship_id=$1', [p.relationship_id])).rows[0]!;
                const marker = `[antseed-relationship:${p.relationship_id}]`, generation = `[antseed-projection:${p.relationship_id}:g${binding.generation}]`;
                const sources = [...snapshot.activeSources, ...snapshot.pendingSources];
                const manual = (await this.db.query("SELECT text FROM outreach_actions WHERE relationship_id=$1 AND actor='antseed' AND state='open' ORDER BY local_date NULLS LAST,instant NULLS LAST,id LIMIT 1", [p.relationship_id])).rows[0];
                const action = manual?.text ?? sources.flatMap(x => x.facts).find(f => f.actor.party === 'antseed' && f.state === 'open')?.text ?? sources.find(x => x.nextAction)?.nextAction ?? sources.find(x => x.reportNextAction)?.reportNextAction ?? (p.stage === 'lead' ? (sources.some(x => x.hasOutbound) ? 'Follow up on the first enquiry' : 'Make initial contact') : 'Next action not recorded');
                const { title, description } = salesCard({ snapshot, stage: p.stage as SalesStage, action, marker, generation });
                let task = binding.task_id ? await this.remoteTask(board, positive(binding.task_id), s) : null;
                if (binding.task_id && !task)
                    throw new DomainError('conflict', 'Managed sales card was deleted; explicit recovery is required');
                if (!task) {
                    const matches = (await this.list(`/projects/${board.projectId}/tasks`, s)).filter(t => String(t.description ?? '').includes(generation));
                    if (matches.length > 1)
                        throw new DomainError('conflict', 'Duplicate sales projection markers');
                    const found = matches[0] ?? obj(await this.write(resource, 'POST', `/projects/${board.projectId}/tasks`, { title, description }, s, String(p.id)));
                    await this.db.query('UPDATE outreach_task_bindings SET task_id=$2 WHERE relationship_id=$1', [p.relationship_id, positive(found.id)]);
                    task = await this.remoteTask(board, positive(found.id), s);
                }
                if (!task || !String(task.task.description ?? '').includes(generation))
                    throw new DomainError('conflict', 'Sales card marker is missing or changed');
                if (binding.published_hash && task.stage !== binding.observed_stage && task.stage !== p.stage && !snapshot.restoreNative)
                    throw new DomainError('conflict', 'Native sales stage drift; propose an evidenced adoption or restore the accepted stage explicitly');
                if (String(task.task.title) !== title || String(task.task.description) !== description)
                    await this.write(resource, 'PATCH', `/tasks/${positive(task.task.id)}`, { title, description }, s, String(p.id));
                // Recheck source fence after descriptive HTTP, before a new lane request.
                if ((await this.workflow.manifest(this.db, String(p.relationship_id))).hash !== current.hash)
                    throw new DomainError('conflict', 'Source changed during publication');
                if (task.stage !== p.stage)
                    await this.write(resource, 'PUT', `/projects/${board.projectId}/views/${board.viewId}/buckets/${board.buckets[p.stage as SalesStage]}/tasks`, { task_id: positive(task.task.id) }, s, String(p.id));
                const readback = await this.remoteTask(board, positive(task.task.id), s);
                if (!readback || readback.stage !== p.stage || readback.task.title !== title || readback.task.description !== description || readback.task.done === true)
                    throw new DomainError('conflict', 'Sales publication readback differs from its immutable accepted snapshot');
                await this.db.transaction(async (tx) => { await tx.query("UPDATE outreach_publications SET state='published',published_at=now(),last_error=NULL WHERE id=$1 AND state='pending'", [p.id]); await tx.query("UPDATE outreach_task_bindings SET observed_stage=$2,published_hash=$3,state='published',last_error=NULL,updated_at=now() WHERE relationship_id=$1", [p.relationship_id, p.stage, p.snapshot_hash]); });
            }
            catch (e) {
                const message = e instanceof DomainError ? e.message : 'Publication interrupted; durable request guard retained';
                await this.db.query('UPDATE outreach_publications SET last_error=$2 WHERE id=$1', [candidate.id, message]).catch(() => { });
                if (e instanceof DomainError && e.code === 'conflict') {
                    await this.db.query("UPDATE outreach_publications SET state='conflict' WHERE id=$1", [candidate.id]).catch(() => { });
                    await this.db.query("UPDATE outreach_task_bindings SET state='conflict',last_error=$2 WHERE relationship_id=$1", [candidate.relationship_id, message]).catch(() => { });
                }
                throw e;
            }
        });
    }
}
