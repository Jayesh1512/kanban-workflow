import { workTitle } from './headline.js';
import { visibleWorkSql } from './work-visibility.js';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../shared/ports.js';
import type { OutreachWorkflow } from '../outreach/service.js';
import { RecordsRepository } from '../workflow/records.js';
import { assert, command, messageRow } from '../workflow/sql.js';
import { audit, canMoveCrm } from '../access/service.js';
import { laneSchema } from '../shared/schemas.js';
import { approvedChatSourceSql } from '../shared/source-approval.js';
import { workParentIsCurrent } from '../shared/crm-first.js';
import { currentTicketMapping } from '../shared/ticket-mapping.js';

const idSchema=z.object({id:z.uuid()});
const pageSchema=z.strictObject({limit:z.coerce.number().int().min(1).max(100).default(50),cursor:z.uuid().optional()});

/** Human-facing records: source eligibility and movement authority stay server-side. */
export function registerTicketDetails(app: FastifyInstance, db: Database, outreach: OutreachWorkflow, ready:()=>Promise<void>) {
  const records=new RecordsRepository(db);
  const history=async(id:string)=>(await db.query(`SELECT a.id,a.action,a.before_value,a.after_value,a.created_at,
    coalesce(nullif(m.display_name,''),split_part(m.email,'@',1)) AS actor_name
    FROM workspace_audit a JOIN workspace_members m ON m.id=a.actor_id
    WHERE a.resource_id=$1 ORDER BY a.created_at DESC,a.id DESC LIMIT 100`,[id])).rows;
  const work=async(id:string)=>{
    const row=(await db.query(`SELECT t.id FROM tickets t JOIN chats c ON c.id=t.chat_id WHERE t.id=$1
      AND t.tracking_state='active' AND c.inclusion='included' AND NOT c.is_control AND ${approvedChatSourceSql('c')}`,[id])).rows[0];
    assert(row,'not_found','Work ticket is no longer available');
    assert(await workParentIsCurrent(db,id),'conflict','Work source no longer belongs to its approved CRM relationship');
  };
  app.get('/api/board/work',async request=>{
    await ready();const input=pageSchema.parse(request.query);
    const rows=(await db.query(`SELECT t.id,t.lane,t.stage_version,t.summary,t.next_action,t.workstream,t.follow_up_at,t.eta_at,t.owner_id,
      coalesce(nullif(m.display_name,''),split_part(m.email,'@',1),'Unassigned') AS owner_name,
      coalesce(co.canonical_name,c.title) AS company_name FROM tickets t JOIN chats c ON c.id=t.chat_id
      LEFT JOIN companies co ON co.id=t.company_id LEFT JOIN workspace_members m ON m.id=t.owner_id
      WHERE ${visibleWorkSql}
      AND ($1::uuid IS NULL OR t.id>$1) ORDER BY t.id LIMIT $2`,[input.cursor??null,input.limit+1])).rows;
    return {items:rows.slice(0,input.limit).map(t=>({id:t.id,lane:t.lane,stageVersion:t.stage_version,summary:t.summary,nextAction:t.next_action,
      workstream:t.workstream,followUpAt:t.follow_up_at,etaAt:t.eta_at,companyName:t.company_name,owner_id:t.owner_id,owner_name:t.owner_name,kind:'work'})),
      nextCursor:rows.length>input.limit?String(rows[input.limit-1]!.id):null};
  });
  app.get('/api/board/tasks/:id',async request=>{
    await ready();const id=idSchema.parse(request.params).id;
    const task=(await db.query(`SELECT t.*,t.due_date::text,
      coalesce(nullif(m.display_name,''),split_part(m.email,'@',1)) AS owner_name
      FROM personal_tasks t JOIN workspace_members m ON m.id=t.owner_id WHERE t.id=$1`,[id])).rows[0];
    assert(task,'not_found','Task not found');return {task,history:await history(id)};
  });
  app.get('/api/board/crm/:id/detail',async request=>{
    await ready();const id=idSchema.parse(request.params).id;
    const detail=await outreach.get(id);
    assert(detail.relationship.acceptedStage,'not_found','CRM relationship not found');
    const proposals=(await db.query(`SELECT id,origin,command_kind,target_stage,reason,state,created_at,decided_at
      FROM outreach_sales_proposals WHERE relationship_id=$1 AND ($2::boolean OR decided_at IS NOT NULL)
      ORDER BY created_at DESC,id DESC LIMIT 100`,[id,canMoveCrm(app.workspaceAccess.user(request))])).rows;
    return {...detail,company:detail.relationship.companyId?await records.getCompany(detail.relationship.companyId):null,
      history:await history(id),proposals};
  });
  app.get('/api/board/work/:id/detail',async request=>{
    await ready();const id=idSchema.parse(request.params).id;await work(id);
    const context=await records.getContext({ticketId:id,limit:50});
    const facts=await records.listFacts({ticketId:id,limit:50});
    const metadata=(await db.query("SELECT t.created_at,t.updated_at,t.owner_id,t.headline,coalesce(nullif(m.display_name,''),split_part(m.email,'@',1),'Unassigned') AS owner_name FROM tickets t LEFT JOIN workspace_members m ON m.id=t.owner_id WHERE t.id=$1",[id])).rows[0];
    const proposals=(await db.query(`SELECT id,source_lane,target_lane,reason,origin,decision,apply_state,created_at,decided_at,applied_at
      FROM proposals WHERE ticket_id=$1 AND ($2::boolean OR decision<>'pending')
      ORDER BY created_at DESC,id DESC LIMIT 100`,[id,canMoveCrm(app.workspaceAccess.user(request))])).rows;
    const evidenceIds=[...new Set([...context.ticket.evidenceIds,...facts.items.flatMap(f=>f.evidenceIds)])];
    const evidence=(await db.query(`SELECT e.* FROM evidence e JOIN messages m ON m.chat_id=e.chat_id AND m.id=e.message_id
      WHERE e.chat_id=$1 AND (e.id=ANY($2::uuid[]) OR e.message_id=ANY($3::int[]))
      AND e.invalidated_at IS NULL AND e.message_version=m.version AND m.deleted_at IS NULL ORDER BY e.observed_at DESC,e.id LIMIT 200`,
      [context.ticket.chatId,evidenceIds,context.messages.map(m=>m.id)])).rows;
    // Message history pages use message IDs so every stored, undeleted message is reachable.
    const messages=(await db.query('SELECT * FROM messages WHERE chat_id=$1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 51',[context.ticket.chatId])).rows;
    return {...context,title:workTitle(context.ticket.nextAction,metadata?.headline as string|null??null),companyName:context.company?.canonicalName??context.chat.title,metadata,evidence: evidence.map(e=>({id:e.id,excerpt:e.excerpt,sourceUrl:e.source_url,observedAt:e.observed_at,messageId:e.message_id})),
      facts:facts.items,factsCursor:facts.nextCursor,messages:messages.slice(0,50).map(messageRow),
      messagesCursor:messages.length>50?Number(messages[49]!.id):null,proposals,history:await history(id)};
  });
  app.get('/api/board/work/:id/facts',async request=>{
    await ready();const id=idSchema.parse(request.params).id,input=pageSchema.parse(request.query);await work(id);
    return records.listFacts({ticketId:id,limit:input.limit,...(input.cursor?{cursor:input.cursor}:{})});
  });
  app.get('/api/board/work/:id/messages',async request=>{
    await ready();const id=idSchema.parse(request.params).id;
    const input=z.strictObject({cursor:z.coerce.number().int().positive().optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).parse(request.query);
    await work(id);
    const rows=(await db.query(`SELECT m.* FROM messages m JOIN tickets t ON t.chat_id=m.chat_id
      WHERE t.id=$1 AND m.deleted_at IS NULL AND ($2::int IS NULL OR m.id<$2) ORDER BY m.id DESC LIMIT $3`,[id,input.cursor??null,input.limit+1])).rows;
    return {items:rows.slice(0,input.limit).map(messageRow),nextCursor:rows.length>input.limit?Number(rows[input.limit-1]!.id):null};
  });
  app.post('/api/board/work/:id/move',async request=>{
    await ready();const actor=app.workspaceAccess.user(request),id=idSchema.parse(request.params).id;
    assert(canMoveCrm(actor),'forbidden','CRM management permission is required');
    const input=z.strictObject({targetLane:laneSchema,expectedStageVersion:z.number().int().nonnegative(),reason:z.string().trim().min(1).max(4000),idempotencyKey:z.uuid()}).parse(request.body);
    return command(db,`work:human-move:${id}`,input.idempotencyKey,{...input,actorId:actor.id},async tx=>{
      const member=(await tx.query('SELECT role,enabled FROM workspace_members WHERE id=$1 FOR SHARE',[actor.id])).rows[0];
      assert(member?.enabled&&['admin','crm_manager'].includes(String(member.role)),'forbidden','CRM management permission is required');
      const chat=(await tx.query('SELECT c.* FROM chats c JOIN tickets t ON t.chat_id=c.id WHERE t.id=$1 FOR UPDATE OF c',[id])).rows[0];
      const before=(await tx.query('SELECT * FROM tickets WHERE id=$1 FOR UPDATE',[id])).rows[0];
      assert(chat&&before,'not_found','Work ticket not found');
      assert(chat.inclusion==='included'&&!chat.is_control&&before.tracking_state==='active','conflict','Work ticket is no longer tracked');
      assert((await tx.query(`SELECT ${approvedChatSourceSql('c')} AS approved FROM chats c WHERE c.id=$1`,[chat.id])).rows[0]?.approved,'conflict','Work source is no longer approved');
      assert(await workParentIsCurrent(tx,id),'conflict','Work source no longer belongs to its approved CRM relationship');
      assert(currentTicketMapping({mappingStatus:chat.mapping_status as 'confirmed',companyId:chat.company_id as string|null},
        {kind:before.kind as 'company'|'contact_prospect',companyId:before.company_id as string|null}),'conflict','Ticket company mapping changed. Refresh before moving.');
      assert(Number(before.stage_version)===input.expectedStageVersion,'conflict','This ticket changed. Reload its latest details before moving.');
      if(before.lane===input.targetLane)return {id,lane:before.lane,stageVersion:Number(before.stage_version)};
      const after=(await tx.query(`UPDATE tickets SET previous_active_lane=CASE WHEN $2='Blocked' AND lane IN ('To be started','Work in progress','Integrations') THEN lane ELSE previous_active_lane END,
        lane=$2,stage_version=stage_version+1,updated_at=now() WHERE id=$1 RETURNING *`,[id,input.targetLane])).rows[0]!;
      await tx.query("UPDATE proposals SET apply_state='stale',last_error='human_move',updated_at=now() WHERE ticket_id=$1 AND apply_state<>'applied'",[id]);
      await audit(tx,actor,'work.move',id,{lane:before.lane,stageVersion:before.stage_version},{lane:after.lane,stageVersion:after.stage_version,reason:input.reason});
      return {id,lane:after.lane,stageVersion:Number(after.stage_version)};
    });
  });
}
