import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDatabase, migrate } from '../../src/platform/database.js';
import { OutreachWorkflow } from '../../src/outreach/service.js';
import { OutreachPublisher } from '../../src/outreach/publisher.js';
import { VikunjaAdapter } from '../../src/vikunja/adapter.js';
import type { RuntimeConfig } from '../../src/shared/ports.js';
const file = process.env['CRM_NATIVE_CONFIG'];
const cfg: RuntimeConfig['jev'] = { provider: 'openai', model: 'gpt-6-luna', endpoint: 'https://api.openai.com/v1/decisions', apiKey: null, timeoutMs: 1000, maxAttempts: 1 };
describe.skipIf(!file)('isolated real PostgreSQL + native Vikunja commercial projection', () => {
    let db: PgDatabase, admin: PgDatabase, workflow: OutreachWorkflow, publisher: OutreachPublisher, v: RuntimeConfig['vikunja'], schema: string;
    beforeAll(async () => { const c = JSON.parse(await readFile(file!, 'utf8')); admin = new PgDatabase(c.databaseUrl); schema = 'crm_' + randomUUID().replaceAll('-', ''); await admin.query(`CREATE SCHEMA ${schema}`); const u = new URL(c.databaseUrl); u.searchParams.set('options', `-c search_path=${schema},public`); db = new PgDatabase(u.toString()); await migrate(db); v = c.vikunja; workflow = new OutreachWorkflow(db, { now: () => new Date() }, cfg); publisher = new OutreachPublisher(db, v, workflow); });
    afterAll(async () => {
        await db?.close();
        if (schema)
            await admin?.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin?.close();
    });
    async function relationship() { const id = randomUUID(); await db.query("INSERT INTO companies(id,canonical_name) VALUES($1,'Cedar Native Fixture')", [id]); const chat = String(-100000 - Math.floor(Math.random() * 100000)); await db.query("INSERT INTO chats(id,kind,title,inclusion,mapping_status,company_id) VALUES($1,'supergroup','Cedar Native Fixture','included','confirmed',$2)", [chat, id]); await db.query('INSERT INTO tickets(chat_id,company_id) VALUES($1,$2)', [chat, id]); await workflow.reconcile(100); return (await workflow.list({})).items.find(r => r.companyId === id)!; }
    it('creates a separate exact five-stage project; preserves original six-bucket board', async () => { const operational = new VikunjaAdapter({ ...v, projectTitle: 'Work Native Fixture' }, db); const work = await operational.ensureBoard(); const before = JSON.stringify(work); const sales = await publisher.ensureBoard(); expect(sales.projectId).not.toBe(Number(work.projectId)); expect(Object.keys(sales.buckets)).toEqual(['lead', 'qualification', 'negotiation', 'won', 'archived']); const view = await publisher.read(`/projects/${sales.projectId}/views/${sales.viewId}`) as any; expect(view.done_bucket_id).toBe(0); expect(view.default_bucket_id).toBe(sales.buckets.lead); expect(JSON.stringify(await operational.ensureBoard())).toBe(before); expect(await publisher.ensureBoard()).toEqual(sales); });
    it('publishes only approved source snapshots and keeps Won/Archived neutral, one native task per relationship', async () => {
        const r = await relationship();
        await db.query("UPDATE outreach_board_binding SET mode='publish'");
        const initial = await workflow.propose({ relationshipId: r.id, expectedEvidenceRevision: r.evidenceRevision, targetStage: 'qualification', idempotencyKey: randomUUID(), reason: 'Native source review' });
        await publisher.tick();
        const review = (await db.query('SELECT * FROM outreach_task_bindings WHERE relationship_id=$1', [r.id])).rows[0]!;
        expect(review.state).toBe('pending_review');
        const reviewTask = await publisher.read(`/tasks/${review.task_id}`) as any;
        expect(reviewTask.title).toContain('Review initial sales stage');
        expect((await workflow.get(r.id)).relationship.acceptedStage).toBeNull();
        await workflow.decide({ proposalId: initial.id, idempotencyKey: randomUUID(), action: 'approve', reason: 'Reviewed conversation' });
        await publisher.tick();
        let binding = (await db.query('SELECT * FROM outreach_task_bindings WHERE relationship_id=$1', [r.id])).rows[0]!;
        expect(binding.observed_stage).toBe('qualification');
        const taskId = binding.task_id;
        expect(taskId).toBe(review.task_id);
        for (const stage of ['negotiation', 'won', 'archived', 'lead']) {
            const current = (await workflow.get(r.id)).relationship;
            const p = await workflow.propose({ relationshipId: r.id, expectedEvidenceRevision: current.evidenceRevision, targetStage: stage, idempotencyKey: randomUUID(), reason: 'Explicit operator commercial assessment' });
            await workflow.decide({ proposalId: p.id, idempotencyKey: randomUUID(), action: 'approve', reason: 'Verified outcome' });
            await publisher.tick();
            binding = (await db.query('SELECT * FROM outreach_task_bindings WHERE relationship_id=$1', [r.id])).rows[0]!;
            expect(binding.task_id).toBe(taskId);
            expect(binding.observed_stage).toBe(stage);
            const remote = await publisher.read(`/tasks/${taskId}`) as any;
            expect(remote.done).toBe(false);
            expect(remote.description).toContain(`[antseed-relationship:${r.id}]`);
        }
        expect((await db.query('SELECT lane,stage_version FROM tickets WHERE company_id=$1', [r.companyId])).rows).toEqual([{ lane: 'To be started', stage_version: 0 }]);
    });
    it('publishes a freshly approved detail replacement directly without redundant redaction requests', async () => {
        const r=await relationship();const p=await workflow.propose({relationshipId:r.id,expectedEvidenceRevision:r.evidenceRevision,targetStage:'qualification',idempotencyKey:randomUUID(),reason:'Initial review'});
        await workflow.decide({proposalId:p.id,idempotencyKey:randomUUID(),action:'approve',reason:'Reviewed'});await publisher.tick();
        await db.query("UPDATE tickets SET next_action='Follow up on updated requirements' WHERE company_id=$1",[r.companyId]);
        await workflow.reconcile(100);await workflow.refreshDetails();
        let redactions=0;const transport:typeof fetch=async(input,init)=>{if(init?.method==='PATCH'&&String(init.body).includes('Relationship — Review changed sources'))redactions++;return fetch(input,init);};
        await new OutreachPublisher(db,v,workflow,transport).tick();
        const binding=(await db.query('SELECT * FROM outreach_task_bindings WHERE relationship_id=$1',[r.id])).rows[0]!;
        expect(binding.state).toBe('published');expect(redactions).toBe(0);
        expect((await publisher.read(`/tasks/${binding.task_id}`)as any).title).toContain('Follow up on updated requirements');
        expect((await workflow.get(r.id)).relationship.stageVersion).toBe(1);
    });
    it('keeps an actual accepted move quarantined across a fresh publisher until its terminal receipt arrives', async () => {
        const r = await relationship();
        await db.query("UPDATE outreach_board_binding SET mode='publish'");
        let current = (await workflow.get(r.id)).relationship;
        let p = await workflow.propose({ relationshipId: r.id, expectedEvidenceRevision: current.evidenceRevision, targetStage: 'lead', idempotencyKey: randomUUID(), reason: 'Initial lead' });
        await workflow.decide({ proposalId: p.id, idempotencyKey: randomUUID(), action: 'approve', reason: 'Reviewed' });
        await publisher.tick();
        current = (await workflow.get(r.id)).relationship;
        p = await workflow.propose({ relationshipId: r.id, expectedEvidenceRevision: current.evidenceRevision, targetStage: 'qualification', idempotencyKey: randomUUID(), reason: 'Two-way evaluation' });
        await workflow.decide({ proposalId: p.id, idempotencyKey: randomUUID(), action: 'approve', reason: 'Reviewed' });
        let moves = 0;
        const transport: typeof fetch = async (input, init) => {
            const response = await fetch(input, init);
            if (init?.method === 'PUT' && String(input).endsWith('/tasks')) {
                moves++;
                await response.body?.cancel();
                throw Error('Synthetic response lost AFTER native endpoint accepted movement');
            }
            return response;
        };
        const broken = new OutreachPublisher(db, v, workflow, transport);
        await expect(broken.tick()).rejects.toMatchObject({ code: 'upstream_unavailable' });
        const q = (await db.query("SELECT * FROM outreach_remote_requests WHERE resource_key=$1 AND state='remote_unresolved'", ['outreach:relationship:' + r.id])).rows[0]!;
        expect(q).toBeTruthy();
        const fresh = new OutreachPublisher(db, v, workflow, transport);
        await fresh.tick();
        await expect(fresh.settle('outreach:relationship:' + r.id)).rejects.toMatchObject({ code: 'upstream_unavailable' });
        expect(moves).toBe(1);
        expect((await db.query('SELECT stage_version FROM outreach_relationships WHERE id=$1', [r.id])).rows[0]!.stage_version).toBe(2);
        // A late immutable terminal receipt is the only release, never the target GET.
        await db.query('INSERT INTO outreach_remote_receipts(request_id,status,body) VALUES($1,200,NULL)', [q.id]);
        await publisher.tick();
        expect((await db.query('SELECT state FROM outreach_publications WHERE id=$1', [(await db.query('SELECT id FROM outreach_publications WHERE decision_id=(SELECT id FROM outreach_sales_decisions WHERE proposal_id=$1)', [p.id])).rows[0]!.id])).rows[0]!.state).toBe('published');
        expect(moves).toBe(1);
    });
    it('retires only a detached managed sales card, keeps its audit snapshot and operational ticket', async () => { const r = await relationship(); const p = await workflow.propose({ relationshipId: r.id, expectedEvidenceRevision: r.evidenceRevision, targetStage: 'lead', idempotencyKey: randomUUID(), reason: 'Initial prospect' }); await workflow.decide({ proposalId: p.id, idempotencyKey: randomUUID(), action: 'approve', reason: 'Reviewed' }); await publisher.tick(); const b = (await db.query('SELECT * FROM outreach_task_bindings WHERE relationship_id=$1', [r.id])).rows[0]!; await db.query("UPDATE chats SET inclusion='excluded',policy_version=policy_version+1 WHERE company_id=$1", [r.companyId]); await publisher.tick(); expect(await publisher.read(`/tasks/${b.task_id}`)).toBeNull(); expect((await db.query('SELECT state,snapshot FROM outreach_retirements WHERE task_id=$1', [b.task_id])).rows[0]).toMatchObject({ state: 'retired', snapshot: { id: Number(b.task_id) } }); expect((await db.query('SELECT id FROM tickets WHERE company_id=$1', [r.companyId])).rows).toHaveLength(1); });
    it('redacts previously published claims after one approved source is excluded without moving the remaining sales card', async () => { const r = await relationship(), chat = '-990001'; await db.query("INSERT INTO chats(id,kind,title,inclusion,mapping_status,company_id) VALUES($1,'supergroup','Sensitive source title','included','confirmed',$2)", [chat, r.companyId]); await db.query('INSERT INTO tickets(chat_id,company_id) VALUES($1,$2)', [chat, r.companyId]); await workflow.reconcile(100); const current = (await workflow.get(r.id)).relationship; const p = await workflow.propose({ relationshipId: r.id, expectedEvidenceRevision: current.evidenceRevision, targetStage: 'qualification', idempotencyKey: randomUUID(), reason: 'Review both sources' }); await workflow.decide({ proposalId: p.id, idempotencyKey: randomUUID(), action: 'approve', reason: 'Both approved' }); await publisher.tick(); const b = (await db.query('SELECT * FROM outreach_task_bindings WHERE relationship_id=$1', [r.id])).rows[0]!; expect((await publisher.read(`/tasks/${b.task_id}`) as any).description).toContain('Sensitive source title'); await db.query("UPDATE chats SET inclusion='excluded',policy_version=policy_version+1 WHERE id=$1", [chat]); await publisher.tick(); const native = await publisher.read(`/tasks/${b.task_id}`) as any; expect(native.description).not.toContain('Sensitive source title'); expect(native.description).toContain('Source context changed'); expect((await db.query('SELECT observed_stage,state FROM outreach_task_bindings WHERE relationship_id=$1', [r.id])).rows[0]).toEqual({ observed_stage: 'qualification', state: 'review_required' }); expect((await db.query('SELECT accepted_stage,stage_version FROM outreach_relationships WHERE id=$1', [r.id])).rows[0]).toEqual({ accepted_stage: 'qualification', stage_version: 1 }); });
    it('keeps other cards progressing while an excluded card has an unresolved remote request',async()=>{
        const blocked=await relationship();let p=await workflow.propose({relationshipId:blocked.id,expectedEvidenceRevision:blocked.evidenceRevision,targetStage:'lead',idempotencyKey:randomUUID(),reason:'Initial prospect'});await workflow.decide({proposalId:p.id,idempotencyKey:randomUUID(),action:'approve',reason:'Reviewed'});await publisher.tick();const request=randomUUID();await db.query("INSERT INTO outreach_remote_requests(id,resource_key,method,path,body,state,dispatched_at) VALUES($1,$2,'PATCH','/synthetic-unknown','{}','remote_unresolved',now())",[request,'outreach:relationship:'+blocked.id]);await db.query("UPDATE chats SET inclusion='excluded',policy_version=policy_version+1 WHERE company_id=$1",[blocked.companyId]);
        const healthy=await relationship();p=await workflow.propose({relationshipId:healthy.id,expectedEvidenceRevision:healthy.evidenceRevision,targetStage:'lead',idempotencyKey:randomUUID(),reason:'A separate prospect'});await workflow.decide({proposalId:p.id,idempotencyKey:randomUUID(),action:'approve',reason:'Reviewed'});await publisher.tick();expect((await db.query('SELECT state FROM outreach_task_bindings WHERE relationship_id=$1',[healthy.id])).rows[0]!.state).toBe('published');expect((await db.query('SELECT state FROM outreach_remote_requests WHERE id=$1',[request])).rows[0]!.state).toBe('remote_unresolved');
    });
    it('holds a native drift and restores it only after an explicitly approved restoration proposal',async()=>{
        const r=await relationship();let p=await workflow.propose({relationshipId:r.id,expectedEvidenceRevision:r.evidenceRevision,targetStage:'qualification',idempotencyKey:randomUUID(),reason:'Evaluate together'});await workflow.decide({proposalId:p.id,idempotencyKey:randomUUID(),action:'approve',reason:'Reviewed'});await publisher.tick();const board=await publisher.ensureBoard();const binding=(await db.query('SELECT * FROM outreach_task_bindings WHERE relationship_id=$1',[r.id])).rows[0]!;const auth=await fetch(v.baseUrl+'/api/v2/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:v.username,password:v.password})}).then(r=>r.json())as{token:string};const moved=await fetch(`${v.baseUrl}/api/v2/projects/${board.projectId}/views/${board.viewId}/buckets/${board.buckets.negotiation}/tasks`,{method:'PUT',headers:{'Content-Type':'application/json',Authorization:`Bearer ${auth.token}`},body:JSON.stringify({task_id:Number(binding.task_id)})});expect(moved.ok).toBe(true);
        let current=(await workflow.get(r.id)).relationship;p=await workflow.propose({relationshipId:r.id,expectedEvidenceRevision:current.evidenceRevision,targetStage:'lead',idempotencyKey:randomUUID(),reason:'Sales assessment without drift authorization'});await workflow.decide({proposalId:p.id,idempotencyKey:randomUUID(),action:'approve',reason:'Reviewed'});await expect(publisher.tick()).rejects.toMatchObject({code:'conflict'});expect((await db.query('SELECT state FROM outreach_task_bindings WHERE relationship_id=$1',[r.id])).rows[0]!.state).toBe('conflict');
        current=(await workflow.get(r.id)).relationship;p=await workflow.propose({relationshipId:r.id,expectedEvidenceRevision:current.evidenceRevision,targetStage:'lead',restoreNative:true,idempotencyKey:randomUUID(),reason:'Operator explicitly restores the accepted stage after reviewing native drift'});await workflow.decide({proposalId:p.id,idempotencyKey:randomUUID(),action:'approve',reason:'Explicit restoration approved'});await publisher.tick();expect((await db.query('SELECT state,observed_stage FROM outreach_task_bindings WHERE relationship_id=$1',[r.id])).rows[0]).toEqual({state:'published',observed_stage:'lead'});expect((await workflow.get(r.id)).relationship.stageVersion).toBe(2);
    });
    it('durably quarantines a lost response and never releases it just because a GET sees target', async () => { const key = 'outreach:relationship:' + randomUUID(); const id = randomUUID(); await db.query("INSERT INTO outreach_remote_requests(id,resource_key,method,path,body,state,dispatched_at) VALUES($1,$2,'PUT','/synthetic-target','{}','remote_unresolved',now())", [id, key]); await expect(publisher.settle(key)).rejects.toMatchObject({ code: 'upstream_unavailable' }); expect((await db.query('SELECT state FROM outreach_remote_requests WHERE id=$1', [id])).rows[0]!.state).toBe('remote_unresolved'); await db.query('INSERT INTO outreach_remote_receipts(request_id,status,body) VALUES($1,200,$2)', [id, JSON.stringify({ id: 1 })]); await publisher.settle(key); expect((await db.query('SELECT state FROM outreach_remote_requests WHERE id=$1', [id])).rows[0]!.state).toBe('verified'); });
});
