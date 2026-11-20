-- A card removed from Initial placement in Approvals keeps its source enrollments
-- and never gains an accepted stage. This marker hides it from the review queue.
-- Placing it later clears the marker.
ALTER TABLE outreach_relationships ADD COLUMN IF NOT EXISTS placement_removed_at timestamptz;

-- Recover earlier removals that recorded only an audit row, unless a later
-- accepted placement already replaced that decision.
DO $$
BEGIN
  IF to_regclass(quote_ident(current_schema()) || '.workspace_audit') IS NOT NULL THEN
    UPDATE outreach_relationships r SET placement_removed_at = x.created_at
    FROM (SELECT resource_id, max(created_at) AS created_at FROM workspace_audit
      WHERE action = 'crm.placement.remove' GROUP BY resource_id) x
    WHERE x.resource_id = r.id AND r.accepted_stage IS NULL
      AND x.created_at > coalesce((SELECT max(a.created_at) FROM workspace_audit a
        WHERE a.action = 'crm.move' AND a.resource_id = r.id), '-infinity'::timestamptz);
  END IF;
END
$$;
