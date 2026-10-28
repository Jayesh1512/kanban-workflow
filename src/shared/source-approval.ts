/** A business source exists after either a correlated control-group reply or
 * an explicit, audited local operator decision. Merely setting inclusion,
 * importing a date range, or possessing stored history is never approval. */
export function approvedChatSourceSql(chatAlias: string): string {
  return `EXISTS(SELECT 1 FROM chat_intake_requests source_approval
    WHERE source_approval.chat_id=${chatAlias}.id
      AND source_approval.decision='approved'
      AND source_approval.decided_at IS NOT NULL
      AND ((coalesce(to_jsonb(source_approval)->>'decision_origin','telegram')='telegram'
        AND source_approval.control_chat_id IS NOT NULL
        AND source_approval.message_id IS NOT NULL
        AND source_approval.decided_message_id IS NOT NULL)
      OR (to_jsonb(source_approval)->>'decision_origin'='operator'
        AND to_jsonb(source_approval)->>'operator_reason' IS NOT NULL
        AND length(btrim(to_jsonb(source_approval)->>'operator_reason'))>0)))`;
}
