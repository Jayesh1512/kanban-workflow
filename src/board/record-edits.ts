import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, SqlExecutor } from '../shared/ports.js';
import { workstreamSchema } from '../shared/schemas.js';
import { assert } from '../workflow/sql.js';
import { audit, canMoveCrm, type Member } from '../access/service.js';
import type { TelegramStore } from '../telegram/store.js';

const idSchema=z.object({id:z.uuid()});
const text=(max:number)=>z.string().trim().max(max);
const instant=z.iso.datetime({offset:true}).nullable();
const workEdit=z.strictObject({headline:text(200).nullable(),nextAction:text(2000).nullable(),summary:text(20000),workstream:workstreamSchema,
  followUpAt:instant,etaAt:instant,ownerId:z.uuid().nullable(),expectedActionsVersion:z.number().int().nonnegative()});
const crmEdit=z.strictObject({displayName:text(300).min(1),workstream:workstreamSchema.nullable(),summary:text(20000),
  nextAction:text(2000).nullable(),followUpDate:z.iso.date().nullable(),expectedEvidenceRevision:z.number().int().nonnegative()});
const blank=(value:string|null)=>value?.trim()?value.trim():null;

/** Rows that point at a Work ticket, removed or detached in FK order so the primary's workers see no dangling ids. */
async function removeTicketTx(tx: SqlExecutor, id: string) {
  const proposals=(await tx.query<{id:string}>('SELECT id FROM proposals WHERE ticket_id=$1',[id])).rows.map(r=>r.id);
  if(proposals.length){
    await tx.query('UPDATE proposals SET correction_of=NULL WHERE correction_of=ANY($1::uuid[])',[proposals]);
    await tx.query('UPDATE telegram_conversation_starts SET initial_proposal_id=NULL WHERE initial_proposal_id=ANY($1::uuid[])',[proposals]);
    for(const table of ['control_outbox','mutations','proposal_decisions','proposal_evidence'])
      await tx.query(`DELETE FROM ${table} WHERE proposal_id=ANY($1::uuid[])`,[proposals]);
    await tx.query('DELETE FROM proposals WHERE id=ANY($1::uuid[])',[proposals]);
  }
  await tx.query('DELETE FROM mutations WHERE ticket_id=$1',[id]);
  // Facts stay with their conversation; only the ticket link goes.
  await tx.query('UPDATE facts SET ticket_id=NULL WHERE ticket_id=$1',[id]);
  await tx.query('UPDATE outreach_source_threads SET ticket_id=NULL WHERE ticket_id=$1',[id]);
  await tx.query('DELETE FROM ticket_contacts WHERE ticket_id=$1',[id]);
  await tx.query('DELETE FROM ticket_evidence WHERE ticket_id=$1',[id]);
  await tx.query('DELETE FROM tickets WHERE id=$1',[id]);
}

/** Direct human edits and permanent deletes for shared Work and CRM records (admins and CRM managers). */
export function registerRecordEdits(app: FastifyInstance, db: Database, ready:()=>Promise<void>, intake?: TelegramStore) {
  const manager=async(request:FastifyRequest)=>{
    await ready();const actor=app.workspaceAccess.user(request);
    assert(canMoveCrm(actor),'forbidden','CRM management permission is required');return actor;
  };
  // Role revocation between the request check and the write must still deny.
  const recheck=async(tx:SqlExecutor,actor:Member)=>{
    const member=(await tx.query('SELECT role,enabled FROM workspace_members WHERE id=$1 FOR SHARE',[actor.id])).rows[0];
    assert(member?.enabled&&['admin','crm_manager'].includes(String(member.role)),'forbidden','CRM management permission is required');
  };
  const lockTicket=async(tx:SqlExecutor,id:string)=>{
    await tx.query('SELECT c.id FROM chats c JOIN tickets t ON t.chat_id=c.id WHERE t.id=$1 FOR UPDATE OF c',[id]);
    const row=(await tx.query('SELECT * FROM tickets WHERE id=$1 FOR UPDATE',[id])).rows[0];
    assert(row,'not_found','Work ticket not found');return row;
  };
  /** Chat -> ticket -> relationship, the lock order used by reconciliation and moves. */
  const lockRelationship=async(tx:SqlExecutor,id:string)=>{
    const chats=(await tx.query<{chat_id:string}>(`SELECT s.chat_id::text FROM outreach_relationship_sources rs JOIN outreach_source_threads s ON s.id=rs.source_thread_id
      WHERE rs.relationship_id=$1 AND s.chat_id IS NOT NULL ORDER BY s.chat_id`,[id])).rows.map(r=>r.chat_id);
    for(const chat of chats)await tx.query('SELECT id FROM chats WHERE id=$1 FOR UPDATE',[chat]);
    const tickets=(await tx.query<{id:string}>(`SELECT id FROM tickets WHERE crm_relationship_id=$1
      OR creation_proposal_id IN (SELECT id FROM outreach_sales_proposals WHERE relationship_id=$1) ORDER BY id FOR UPDATE`,[id])).rows.map(r=>r.id);
    const row=(await tx.query('SELECT * FROM outreach_relationships WHERE id=$1 AND retained FOR UPDATE',[id])).rows[0];
    assert(row?.accepted_stage,'not_found','CRM relationship not found');
    return {row,chats,tickets};
  };

  app.get('/api/board/people',async request=>{
    await ready();app.workspaceAccess.user(request);
    return {items:(await db.query(`SELECT id,coalesce(nullif(display_name,''),split_part(email,'@',1)) AS name FROM workspace_members
      WHERE enabled ORDER BY lower(coalesce(nullif(display_name,''),email))`)).rows};
  });

  app.patch('/api/board/work/:id',async request=>{
    const actor=await manager(request),id=idSchema.parse(request.params).id,input=workEdit.parse(request.body);
    return db.transaction(async tx=>{
      await recheck(tx,actor);const before=await lockTicket(tx,id);
      assert(before.tracking_state==='active','conflict','Work ticket is no longer tracked');
      assert(Number(before.actions_version)===input.expectedActionsVersion,'conflict','This ticket changed. Reload its latest details before saving.');
      if(input.ownerId)assert((await tx.query('SELECT 1 FROM workspace_members WHERE id=$1 AND enabled',[input.ownerId])).rowCount,'validation','Choose an active workspace member as owner');
      // Manual actions keep later AI analysis from overwriting what a person typed.
      const after=(await tx.query(`UPDATE tickets SET headline=$2,next_action=$3,summary=$4,workstream=$5,follow_up_at=$6,eta_at=$7,owner_id=$8,
        actions_source='manual',actions_version=actions_version+1,updated_at=now() WHERE id=$1 AND actions_version=$9 RETURNING *`,
      [id,blank(input.headline),blank(input.nextAction),input.summary,input.workstream,input.followUpAt,input.etaAt,input.ownerId,input.expectedActionsVersion])).rows[0]!;
      const pick=(r:Record<string,unknown>)=>({headline:r.headline,nextAction:r.next_action,summary:r.summary,workstream:r.workstream,followUpAt:r.follow_up_at,etaAt:r.eta_at,ownerId:r.owner_id});
      await audit(tx,actor,'work.update',id,pick(before),pick(after));
      return {id,actionsVersion:Number(after.actions_version)};
    });
  });

  app.delete('/api/board/work/:id',async request=>{
    const actor=await manager(request),id=idSchema.parse(request.params).id;
    const input=z.strictObject({expectedActionsVersion:z.number().int().nonnegative()}).parse(request.body);
    return db.transaction(async tx=>{
      await recheck(tx,actor);const before=await lockTicket(tx,id);
      assert(Number(before.actions_version)===input.expectedActionsVersion,'conflict','This ticket changed. Reload its latest details before deleting.');
      await audit(tx,actor,'work.delete',id,{chatId:String(before.chat_id),headline:before.headline,nextAction:before.next_action,lane:before.lane,crmRelationshipId:before.crm_relationship_id},null);
      await removeTicketTx(tx,id);return {deleted:true};
    });
  });

  app.patch('/api/board/crm/:id',async request=>{
    const actor=await manager(request),id=idSchema.parse(request.params).id,input=crmEdit.parse(request.body);
    return db.transaction(async tx=>{
      await recheck(tx,actor);const {row:before}=await lockRelationship(tx,id);
      assert(Number(before.evidence_revision)===input.expectedEvidenceRevision,'conflict','This relationship changed. Reload its latest details before saving.');
      const action=(await tx.query("SELECT * FROM outreach_actions WHERE relationship_id=$1 AND actor='antseed' AND state='open' ORDER BY local_date NULLS LAST,instant NULLS LAST,id LIMIT 1 FOR UPDATE",[id])).rows[0];
      const nextAction=blank(input.nextAction),precision=input.followUpDate?'date':'none';
      if(action&&nextAction)await tx.query(`UPDATE outreach_actions SET text=$2,precision=$3,local_date=$4,instant=NULL,origin='manual',version=version+1 WHERE id=$1`,[action.id,nextAction,precision,input.followUpDate]);
      else if(action)await tx.query("UPDATE outreach_actions SET state='cancelled',version=version+1 WHERE id=$1",[action.id]);
      else if(nextAction)await tx.query(`INSERT INTO outreach_actions(relationship_id,text,actor,state,precision,local_date,origin) VALUES($1,$2,'antseed','open',$3,$4,'manual')`,[id,nextAction,precision,input.followUpDate]);
      // identity_version>0 tells reconciliation to keep the human name, workstream and notes.
      const after=(await tx.query(`UPDATE outreach_relationships SET display_name=$2,workstream=$3,summary=$4,identity_version=identity_version+1,
        actions_version=actions_version+1,evidence_revision=evidence_revision+1,updated_at=now() WHERE id=$1 RETURNING *`,[id,input.displayName,input.workstream,input.summary])).rows[0]!;
      // Pending AI identity/follow-up suggestions describe the record before this edit.
      await tx.query("UPDATE outreach_sales_proposals SET state='stale' WHERE relationship_id=$1 AND state='pending' AND command_kind IN ('actions','identity')",[id]);
      await tx.query("UPDATE outreach_control_outbox SET state='cancelled' WHERE proposal_id IN (SELECT id FROM outreach_sales_proposals WHERE relationship_id=$1 AND state='stale') AND state<>'sent'",[id]);
      await audit(tx,actor,'crm.update',id,{displayName:before.display_name,workstream:before.workstream,summary:before.summary,nextAction:action?.text??null,followUpDate:action?.local_date??null},
        {displayName:after.display_name,workstream:after.workstream,summary:after.summary,nextAction,followUpDate:input.followUpDate});
      return {id,evidenceRevision:Number(after.evidence_revision)};
    });
  });

  app.delete('/api/board/crm/:id',async request=>{
    const actor=await manager(request),id=idSchema.parse(request.params).id;
    const input=z.strictObject({expectedEvidenceRevision:z.number().int().nonnegative()}).parse(request.body);
    return db.transaction(async tx=>{
      await recheck(tx,actor);const {row:before,chats,tickets}=await lockRelationship(tx,id);
      assert(Number(before.evidence_revision)===input.expectedEvidenceRevision,'conflict','This relationship changed. Reload its latest details before deleting.');
      await audit(tx,actor,'crm.delete',id,{displayName:before.display_name,stage:before.accepted_stage,companyId:before.company_id,chatIds:chats,workTicketIds:tickets},null);
      for(const ticket of tickets)await removeTicketTx(tx,ticket);
      const proposals=(await tx.query<{id:string}>('SELECT id FROM outreach_sales_proposals WHERE relationship_id=$1',[id])).rows.map(r=>r.id);
      const publications=(await tx.query<{id:string}>('SELECT id FROM outreach_publications WHERE relationship_id=$1',[id])).rows.map(r=>r.id);
      if(publications.length){
        await tx.query('DELETE FROM outreach_remote_receipts WHERE request_id IN (SELECT id FROM outreach_remote_requests WHERE publication_id=ANY($1::uuid[]))',[publications]);
        await tx.query('DELETE FROM outreach_remote_requests WHERE publication_id=ANY($1::uuid[])',[publications]);
      }
      await tx.query('DELETE FROM outreach_publications WHERE relationship_id=$1',[id]);
      if(proposals.length){
        await tx.query('DELETE FROM outreach_control_outbox WHERE proposal_id=ANY($1::uuid[])',[proposals]);
        await tx.query('DELETE FROM outreach_sales_decisions WHERE proposal_id=ANY($1::uuid[]) OR replacement_id=ANY($1::uuid[])',[proposals]);
        await tx.query('DELETE FROM outreach_sales_proposals WHERE id=ANY($1::uuid[])',[proposals]);
      }
      const sources=(await tx.query<{id:string}>('SELECT source_thread_id AS id FROM outreach_relationship_sources WHERE relationship_id=$1',[id])).rows.map(r=>r.id);
      for(const table of ['outreach_actions','outreach_assessments','outreach_detail_refresh','outreach_identity_audit','outreach_retirements','outreach_task_bindings','outreach_relationship_sources'])
        await tx.query(`DELETE FROM ${table} WHERE relationship_id=$1`,[id]);
      if(sources.length){
        await tx.query('DELETE FROM outreach_report_context WHERE source_id=ANY($1::uuid[])',[sources]);
        await tx.query('DELETE FROM outreach_source_threads WHERE id=ANY($1::uuid[])',[sources]);
      }
      await tx.query('DELETE FROM outreach_relationships WHERE id=$1',[id]);
      // Excluding the source chats stops reconciliation from recreating the deal on its next sweep.
      let excluded=0;
      for(const chatId of chats){
        const chat=intake?await intake.lockedChat(tx,chatId):null;
        if(chat&&chat.inclusion!=='excluded'){await intake!.changeInclusion(tx,chat,'excluded');excluded++;}
        else if(!intake){await tx.query("UPDATE chats SET inclusion='excluded',policy_version=policy_version+1,updated_at=now() WHERE id=$1 AND inclusion<>'excluded'",[chatId]);excluded++;}
      }
      return {deleted:true,workTickets:tickets.length,excludedChats:excluded};
    });
  });
}
