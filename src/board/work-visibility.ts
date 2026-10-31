import { approvedChatSourceSql } from '../shared/source-approval.js';

/** Shared by the personal/team feed and the CRM Work feed. Aliases: t, c. */
export const visibleWorkSql=`t.tracking_state='active' AND c.inclusion='included' AND NOT c.is_control AND ${approvedChatSourceSql('c')}
  AND (t.creation_proposal_id IS NULL OR EXISTS(
    SELECT 1 FROM outreach_relationship_sources rs JOIN outreach_source_threads s ON s.id=rs.source_thread_id
    JOIN outreach_relationships r ON r.id=rs.relationship_id WHERE s.chat_id=t.chat_id AND rs.relationship_id=t.crm_relationship_id
    AND rs.enrollment_state='active' AND r.retained AND r.accepted_stage IS NOT NULL AND r.company_id IS NOT DISTINCT FROM t.company_id))`;
