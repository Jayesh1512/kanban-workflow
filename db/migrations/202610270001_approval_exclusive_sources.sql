-- Business tickets may be sourced only from chats admitted by a correlated
-- approve reply to the exact Telegram control-group intake message. Preserve
-- all stored history and accepted stages; suspend projections for every other
-- source so they can be restored by a future explicit intake approval.

DELETE FROM app_settings WHERE key='telegram:automatic-since';

CREATE TEMP TABLE approval_exclusive_chats ON COMMIT DROP AS
SELECT c.id
FROM chats c
WHERE NOT c.is_control
  AND NOT EXISTS (
    SELECT 1 FROM chat_intake_requests r
    WHERE r.chat_id=c.id
      AND r.decision='approved'
      AND r.control_chat_id IS NOT NULL
      AND r.message_id IS NOT NULL
      AND r.decided_message_id IS NOT NULL
      AND r.decided_at IS NOT NULL
  );

UPDATE chats c
SET inclusion='excluded',policy_version=policy_version+1,updated_at=now()
FROM approval_exclusive_chats denied
WHERE c.id=denied.id AND c.inclusion<>'excluded';

UPDATE tickets t SET tracking_state='suspended',updated_at=now()
FROM approval_exclusive_chats denied WHERE t.chat_id=denied.id AND t.tracking_state<>'suspended';

UPDATE analysis_jobs j
SET status='cancelled',worker_id=NULL,lease_until=NULL,last_error='telegram_control_approval_required',updated_at=now()
FROM approval_exclusive_chats denied
WHERE j.chat_id=denied.id AND j.status NOT IN ('completed','cancelled');

UPDATE proposals p
SET apply_state=CASE WHEN p.apply_state IN ('applying','reconciling') THEN 'reconciling' ELSE 'stale' END,
    last_error='telegram_control_approval_required',updated_at=now()
FROM tickets t JOIN approval_exclusive_chats denied ON denied.id=t.chat_id
WHERE p.ticket_id=t.id AND p.apply_state<>'applied';

UPDATE history_cursors h
SET status='paused',generation=generation+1,worker_id=NULL,lease_until=NULL,updated_at=now()
FROM approval_exclusive_chats denied WHERE h.chat_id=denied.id;
UPDATE telegram_history_requests h SET remaining_batches=0
FROM approval_exclusive_chats denied WHERE h.chat_id=denied.id;
UPDATE live_checkpoints l SET replay_required=false,generation=generation+1
FROM approval_exclusive_chats denied WHERE l.chat_id=denied.id;

CREATE TEMP TABLE approval_exclusive_relationships ON COMMIT DROP AS
SELECT DISTINCT rs.relationship_id
FROM outreach_relationship_sources rs
JOIN outreach_source_threads s ON s.id=rs.source_thread_id
LEFT JOIN approval_exclusive_chats denied ON denied.id=s.chat_id
WHERE s.kind<>'telegram' OR denied.id IS NOT NULL;

UPDATE outreach_relationship_sources rs
SET enrollment_state='suspended',version=version+1,updated_at=now()
FROM outreach_source_threads s
LEFT JOIN approval_exclusive_chats denied ON denied.id=s.chat_id
WHERE rs.source_thread_id=s.id
  AND (s.kind<>'telegram' OR denied.id IS NOT NULL)
  AND rs.enrollment_state<>'suspended';

UPDATE outreach_relationships r
SET evidence_revision=evidence_revision+1,updated_at=now()
FROM approval_exclusive_relationships changed WHERE r.id=changed.relationship_id;

UPDATE outreach_sales_proposals p SET state='stale'
FROM approval_exclusive_relationships changed
WHERE p.relationship_id=changed.relationship_id AND p.state='pending';
UPDATE outreach_assessments a SET status='stale',claim_token=NULL,retry_at=NULL,updated_at=now()
FROM approval_exclusive_relationships changed
WHERE a.relationship_id=changed.relationship_id AND a.status IN ('running','complete','unavailable','uncertain');
UPDATE outreach_publications p SET state='superseded',last_error='telegram_control_approval_required'
FROM approval_exclusive_relationships changed
WHERE p.relationship_id=changed.relationship_id AND p.state='pending';

-- Fathom remains a searchable meeting archive, but its independent action
-- exports are not approved Telegram-chat tickets and therefore leave Kanban.
ALTER TABLE meeting_task_exports DROP CONSTRAINT meeting_task_exports_state_check;
ALTER TABLE meeting_task_exports ADD CONSTRAINT meeting_task_exports_state_check
  CHECK (state IN ('queued','dispatched','created','unknown','failed','canceled','retired'));
ALTER TABLE meeting_task_exports DROP CONSTRAINT meeting_task_exports_check;
ALTER TABLE meeting_task_exports ADD CONSTRAINT meeting_task_exports_request_state_check
  CHECK (request_id IS NULL OR state IN ('dispatched','unknown','created','retired'));
UPDATE meeting_task_exports
SET state='retired',remote_url=NULL,last_error='Non-Telegram source retired by approval-exclusive policy',claim_token=NULL,updated_at=now()
WHERE state IN ('queued','failed','canceled') AND request_id IS NULL;

INSERT INTO app_settings(key,value) VALUES(
  'telegram:approval-exclusive-sources',
  jsonb_build_object('enabled',true,'activatedAt',now(),'rule','correlated_control_reply')
) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now();
