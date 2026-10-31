import type { SqlExecutor } from '../shared/ports.js';

/** Initial account setup/cutover only; never overwrite an existing assignment. */
export async function initializeWorkOwner(tx: SqlExecutor, memberId: string): Promise<number> {
  await tx.query(`INSERT INTO app_settings(key,value) VALUES('workspace:default-work-owner',jsonb_build_object('memberId',$1::text))
    ON CONFLICT(key) DO NOTHING`,[memberId]);
  const setting=(await tx.query("SELECT value FROM app_settings WHERE key='workspace:default-work-owner' FOR UPDATE")).rows[0];
  if((setting?.value as {memberId?:string}|undefined)?.memberId!==memberId)return 0;
  const changed=(await tx.query('UPDATE tickets SET owner_id=$1 WHERE owner_id IS NULL RETURNING id',[memberId])).rows;
  if(changed.length)await tx.query(`INSERT INTO workspace_audit(actor_id,action,resource_id,before_value,after_value)
    SELECT $1::uuid,'work.assign',id,'{"ownerId":null}'::jsonb,jsonb_build_object('ownerId',$1::uuid,'reason','Initial generated-task ownership')
    FROM tickets WHERE id=ANY($2::uuid[])`,[memberId,changed.map(row=>row.id)]);
  return changed.length;
}
