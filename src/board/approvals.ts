import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../shared/ports.js';
import { DomainError } from '../shared/api.js';
import { canMoveCrm } from '../access/service.js';
import type { OutreachWorkflow } from '../outreach/service.js';
import type { ProposalRepository } from '../workflow/proposals.js';
import type { TelegramStore } from '../telegram/store.js';
import { salesDecisionSchema, salesProposalSchema } from '../shared/outreach-schemas.js';

export type ApprovalServices = { work?: ProposalRepository; intake?: TelegramStore };
const pageSchema=z.strictObject({limit:z.coerce.number().int().min(1).max(100).default(50),cursor:z.uuid().optional()});
const idSchema=z.object({id:z.uuid()});
const decisionSchema=z.strictObject({action:z.enum(['approve','reject']),reason:z.string().trim().min(1).max(4000),idempotencyKey:z.string().min(1).max(200)});

/** Private review transport. Generic agent APIs retain their existing decision restrictions. */
export function registerApprovals(app: FastifyInstance, db: Database, outreach: OutreachWorkflow, ready:()=>Promise<void>, services: ApprovalServices) {
  const reviewer=async(request:Parameters<typeof app.workspaceAccess.user>[0],admin=false)=>{
    await ready();const actor=app.workspaceAccess.user(request);
    if(admin ? actor.role!=='admin' : !canMoveCrm(actor)) throw new DomainError('forbidden',admin?'Administrator access is required':'CRM management permission is required');
    return actor;
  };
  const page=(rows:Record<string,unknown>[],limit:number)=>({items:rows.slice(0,limit),nextCursor:rows.length>limit?String(rows[limit-1]!.id):null});
  app.get('/api/board/approvals/placements',async request=>{
    await reviewer(request);const input=pageSchema.parse(request.query);
    return outreach.listReviewRelationships({limit:input.limit,...(input.cursor?{cursor:input.cursor}:{})});
  });
  app.get('/api/board/approvals/relationships/:id',async request=>{
    await reviewer(request);return outreach.get(idSchema.parse(request.params).id);
  });
  app.post('/api/board/approvals/relationships/:id/place',async request=>{
    const actor=await reviewer(request),id=idSchema.parse(request.params).id;
    const input=salesProposalSchema.omit({relationshipId:true}).parse(request.body);
    return outreach.moveByHuman({...input,relationshipId:id},actor,'unplaced');
  });
  app.get('/api/board/approvals/proposals',async request=>{
    await reviewer(request);const input=pageSchema.parse(request.query);
    const rows=(await db.query(`SELECT p.id,p.relationship_id,p.target_stage,p.reason,p.command_kind,p.command_payload,p.origin,p.state,p.created_at,
      r.display_name,r.accepted_stage FROM outreach_sales_proposals p
      JOIN outreach_relationships r ON r.id=p.relationship_id WHERE p.state='pending' AND r.retained
      AND ($1::uuid IS NULL OR p.id>$1) ORDER BY p.id LIMIT $2`,[input.cursor??null,input.limit+1])).rows;
    return page(rows,input.limit);
  });
  app.post('/api/board/approvals/proposals/:id/decision',async request=>{
    const actor=await reviewer(request),id=idSchema.parse(request.params).id;
    const input=salesDecisionSchema.parse({...z.record(z.string(),z.unknown()).parse(request.body),proposalId:id});
    return outreach.decideByHuman(input,actor);
  });
  app.get('/api/board/approvals/work',async request=>{
    await reviewer(request);const input=pageSchema.parse(request.query);
    const rows=(await db.query(`SELECT p.id,p.ticket_id,p.source_lane,p.target_lane,p.reason,p.next_action,p.created_at,
      coalesce(co.canonical_name,c.title) AS display_name FROM proposals p JOIN tickets t ON t.id=p.ticket_id
      JOIN chats c ON c.id=t.chat_id LEFT JOIN companies co ON co.id=t.company_id
      WHERE p.decision='pending' AND p.apply_state<>'stale' AND ($1::uuid IS NULL OR p.id>$1)
      ORDER BY p.id LIMIT $2`,[input.cursor??null,input.limit+1])).rows;
    return page(rows,input.limit);
  });
  app.post('/api/board/approvals/work/:id/decision',async request=>{
    const actor=await reviewer(request),id=idSchema.parse(request.params).id,input=decisionSchema.parse(request.body);
    if(!services.work) throw new DomainError('not_configured','Work approvals are unavailable');
    return services.work.decideByHuman({proposalId:id,decision:input.action,note:input.reason,idempotencyKey:input.idempotencyKey},actor);
  });
  app.get('/api/board/approvals/intake',async request=>{
    await reviewer(request,true);const input=pageSchema.parse(request.query);
    const rows=(await db.query(`SELECT r.id,r.chat_id,c.title,c.kind,c.username,r.created_at,r.policy_version
      FROM chat_intake_requests r JOIN chats c ON c.id=r.chat_id
      WHERE r.decision='pending' AND c.inclusion='undecided' AND NOT c.is_control AND c.policy_version=r.policy_version
      AND ($1::uuid IS NULL OR r.id>$1) ORDER BY r.id LIMIT $2`,[input.cursor??null,input.limit+1])).rows;
    return page(rows,input.limit);
  });
  app.post('/api/board/approvals/intake/:id/decision',async request=>{
    const actor=await reviewer(request,true),id=idSchema.parse(request.params).id;
    if(!services.intake) throw new DomainError('not_configured','Chat intake approvals are unavailable');
    return services.intake.decideIntakeByHuman(id,request.body,actor);
  });
}
