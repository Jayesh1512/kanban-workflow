import type { SqlExecutor } from './ports.js';

/** The additive migration enables this only after the independent CRM model exists. */
export async function crmFirstEnabled(db: SqlExecutor): Promise<boolean> {
  return (await db.query("SELECT value->>'enabled' AS enabled FROM app_settings WHERE key='workflow:crm-first'")).rows[0]?.enabled === 'true';
}

/** Historical tickets retain their existing approval; new action tickets must
 * still belong to the CRM source that authorized their creation. */
export async function workParentIsCurrent(db: SqlExecutor, ticketId: string): Promise<boolean> {
  if (!await crmFirstEnabled(db)) return true;
  return (await db.query(`SELECT (t.creation_proposal_id IS NULL OR EXISTS(
    SELECT 1 FROM outreach_relationship_sources rs JOIN outreach_source_threads s ON s.id=rs.source_thread_id
    JOIN outreach_relationships r ON r.id=rs.relationship_id
    WHERE s.chat_id=t.chat_id AND rs.relationship_id=t.crm_relationship_id AND rs.enrollment_state='active'
      AND r.accepted_stage IS NOT NULL AND r.company_id IS NOT DISTINCT FROM t.company_id)) AS current
    FROM tickets t WHERE t.id=$1`, [ticketId])).rows[0]?.current === true;
}
