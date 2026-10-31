-- Collapse pending approvals that ask for the identical change. The oldest is kept
-- (its Telegram message may already be sent); the rest become stale, which is the
-- existing "no longer actionable" state, and their undelivered messages are cancelled.
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY relationship_id, command_kind, input_hash,
      CASE command_kind WHEN 'stage' THEN target_stage
        WHEN 'work' THEN lower(btrim(command_payload->>'action')) || '|' || (command_payload->>'chatId')
        ELSE command_payload::text END
    ORDER BY created_at, id) AS rn
  FROM outreach_sales_proposals WHERE state='pending'
), dupes AS (
  UPDATE outreach_sales_proposals p SET state='stale'
  FROM ranked WHERE ranked.id=p.id AND ranked.rn>1 RETURNING p.id
)
UPDATE outreach_control_outbox SET state='cancelled' WHERE proposal_id IN (SELECT id FROM dupes) AND state<>'sent';

UPDATE proposals SET apply_state='stale', last_error='duplicate_pending', updated_at=now()
WHERE id IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (PARTITION BY ticket_id, target_lane, source_stage_version ORDER BY created_at, id) AS rn
    FROM proposals WHERE decision='pending' AND apply_state<>'stale'
  ) x WHERE rn>1);
