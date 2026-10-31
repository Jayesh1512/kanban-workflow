import { visibleWorkSql } from './work-visibility.js';
import { registerApprovals, type ApprovalServices } from './approvals.js';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../shared/ports.js';
import { laneSchema } from '../shared/schemas.js';
import { DomainError } from '../shared/api.js';
import { AccessControl, audit, canMoveCrm, canOwnTasks } from '../access/service.js';
import type { OutreachWorkflow } from '../outreach/service.js';
import { salesProposalSchema } from '../shared/outreach-schemas.js';
import { workspacePage, loginPage } from './page.js';
import { approvedChatSourceSql } from '../shared/source-approval.js';
import { registerTicketDetails } from './ticket-details.js';
import { workTitle } from './headline.js';

declare module 'fastify' { interface FastifyInstance { workspaceAccess: AccessControl } }

const taskFields = {
  title:z.string().trim().min(1).max(500),description:z.string().max(20000).default(''),
  lane:laneSchema.default('To be started'),dueDate:z.iso.date().nullable().default(null),
};
const taskSelect = `t.id,t.owner_id,t.title,t.description,t.lane,t.due_date::text,t.version,t.created_at,t.updated_at,
  coalesce(nullif(m.display_name,''),split_part(m.email,'@',1)) AS owner_name`;

export function registerBoard(app: FastifyInstance, db: Database, outreach: OutreachWorkflow, ready: () => Promise<void>, timezone = 'Asia/Kolkata', approvals: ApprovalServices = {}) {
  const access = app.workspaceAccess;
  registerTicketDetails(app,db,outreach,ready);
  registerApprovals(app,db,outreach,ready,approvals);
  app.get('/login',async (_request,reply)=>reply.type('text/html; charset=utf-8').send(loginPage));
  for (const path of ['/dashboard','/work','/team','/approvals']) app.get(path,async (_request,reply)=>reply.type('text/html; charset=utf-8').send(workspacePage));
  app.get('/api/board/tasks',async request => {
    await ready(); const member=access.user(request);
    const input=z.strictObject({scope:z.enum(['mine','team']).default('mine'),limit:z.coerce.number().int().min(1).max(200).default(100),cursor:z.uuid().optional()}).parse(request.query);
    const rows=(await db.query(`WITH tasks AS (
      SELECT ${taskSelect},'personal'::text AS kind,NULL::text AS company,NULL::text AS next_action,NULL::text AS headline FROM personal_tasks t JOIN workspace_members m ON m.id=t.owner_id
      UNION ALL
      SELECT t.id,t.owner_id,t.next_action AS title,
        t.summary AS description,t.lane,(LEAST(t.eta_at,t.follow_up_at) AT TIME ZONE $4)::date::text AS due_date,
        t.stage_version AS version,t.created_at,t.updated_at,
        coalesce(nullif(m.display_name,''),split_part(m.email,'@',1),'Unassigned') AS owner_name,'work'::text AS kind,
        coalesce(co.canonical_name,c.title) AS company,t.next_action,t.headline
      FROM tickets t JOIN chats c ON c.id=t.chat_id LEFT JOIN companies co ON co.id=t.company_id
      LEFT JOIN workspace_members m ON m.id=t.owner_id WHERE ${visibleWorkSql}
    ) SELECT * FROM tasks WHERE ($1::uuid IS NULL OR owner_id=$1) AND ($2::uuid IS NULL OR id>$2)
      ORDER BY id LIMIT $3`,[input.scope==='mine'?member.id:null,input.cursor??null,input.limit+1,timezone])).rows;
    const items=rows.slice(0,input.limit).map(({next_action,headline,...row})=>row.kind==='work'?{...row,title:workTitle(next_action as string|null,headline as string|null),description:''}:row);
    return {items,nextCursor:rows.length>input.limit?String(rows[input.limit-1]!.id):null};
  });
  app.post('/api/board/tasks',async request => {
    await ready(); const actor=access.user(request);
    if(!canOwnTasks(actor))throw new DomainError('forbidden','Viewers cannot create tasks');
    const input=z.strictObject({...taskFields,idempotencyKey:z.uuid()}).parse(request.body);
    return db.transaction(async tx=>{
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`task:create:${actor.id}:${input.idempotencyKey}`]);
      const old=(await tx.query('SELECT *,due_date::text FROM personal_tasks WHERE owner_id=$1 AND creation_key=$2',[actor.id,input.idempotencyKey])).rows[0];
      if(old) {
        if(old.title!==input.title || old.description!==input.description || old.lane!==input.lane || (old.due_date ? String(old.due_date).slice(0,10) : null)!==input.dueDate)
          throw new DomainError('conflict','Task creation key was reused');
        return old;
      }
      const row=(await tx.query(`INSERT INTO personal_tasks(owner_id,title,description,lane,due_date,creation_key)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *,due_date::text`,[actor.id,input.title,input.description,input.lane,input.dueDate,input.idempotencyKey])).rows[0]!;
      await audit(tx,actor,'task.create',String(row.id),null,row);return row;
    });
  });
  app.patch('/api/board/tasks/:id',async request=>{
    await ready(); const actor=access.user(request),id=z.object({id:z.uuid()}).parse(request.params).id;
    if(!canOwnTasks(actor))throw new DomainError('forbidden','Viewers cannot change tasks');
    const input=z.strictObject({...taskFields,expectedVersion:z.number().int().nonnegative()}).parse(request.body);
    return db.transaction(async tx=>{
      const before=(await tx.query('SELECT *,due_date::text FROM personal_tasks WHERE id=$1 AND owner_id=$2 FOR UPDATE',[id,actor.id])).rows[0];
      if(!before)throw new DomainError('not_found','Your task was not found');
      if(Number(before.version)!==input.expectedVersion)throw new DomainError('conflict','This task changed. Refresh before saving.');
      const row=(await tx.query(`UPDATE personal_tasks SET title=$3,description=$4,lane=$5,due_date=$6,version=version+1,updated_at=now()
        WHERE id=$1 AND owner_id=$2 AND version=$7 RETURNING *,due_date::text`,[id,actor.id,input.title,input.description,input.lane,input.dueDate,input.expectedVersion])).rows[0]!;
      await audit(tx,actor,'task.update',id,before,row);return row;
    });
  });
  app.delete('/api/board/tasks/:id',async request=>{
    await ready();const actor=access.user(request),id=z.object({id:z.uuid()}).parse(request.params).id;
    if(!canOwnTasks(actor))throw new DomainError('forbidden','Viewers cannot delete tasks');
    const input=z.strictObject({expectedVersion:z.number().int().nonnegative()}).parse(request.body);
    return db.transaction(async tx=>{
      const before=(await tx.query('SELECT * FROM personal_tasks WHERE id=$1 AND owner_id=$2 FOR UPDATE',[id,actor.id])).rows[0];
      if(!before)throw new DomainError('not_found','Your task was not found');
      if(Number(before.version)!==input.expectedVersion)throw new DomainError('conflict','This task changed. Refresh before deleting.');
      await audit(tx,actor,'task.delete',id,before,null);
      await tx.query('DELETE FROM personal_tasks WHERE id=$1 AND owner_id=$2',[id,actor.id]);return {deleted:true};
    });
  });
  app.post('/api/board/crm/:id/move',async request=>{
    await ready();const actor=access.user(request);
    if(!canMoveCrm(actor))throw new DomainError('forbidden','CRM management permission is required');
    const id=z.object({id:z.uuid()}).parse(request.params).id;
    const input=salesProposalSchema.omit({relationshipId:true}).parse(request.body);
    return outreach.moveByHuman({...input,relationshipId:id},actor,'accepted');
  });
  app.get('/api/board/summary',async ()=>{
    await ready();
    const row=(await db.query(`WITH current_work AS (
      SELECT t.* FROM tickets t JOIN chats c ON c.id=t.chat_id
      WHERE t.tracking_state='active' AND c.inclusion='included' AND NOT c.is_control AND ${approvedChatSourceSql('c')}
    ) SELECT
      ((SELECT count(*) FROM personal_tasks WHERE lane NOT IN ('Archived','Completed'))+
       (SELECT count(*) FROM current_work WHERE lane NOT IN ('Archived','Completed')))::int AS active_tasks,
      ((SELECT count(*) FROM personal_tasks WHERE due_date<(now() AT TIME ZONE $1)::date AND lane NOT IN ('Archived','Completed'))+
       (SELECT count(*) FROM current_work WHERE (LEAST(eta_at,follow_up_at) AT TIME ZONE $1)::date<(now() AT TIME ZONE $1)::date AND lane NOT IN ('Archived','Completed')))::int AS overdue_tasks,
      ((SELECT count(*) FROM personal_tasks WHERE lane='Completed')+
       (SELECT count(*) FROM current_work WHERE lane='Completed'))::int AS completed_tasks,
      (SELECT count(*)::int FROM workspace_members WHERE enabled) AS members`,[timezone])).rows[0]!;
    const crm=await outreach.status();return {...row,crm:crm.kpis};
  });
}
