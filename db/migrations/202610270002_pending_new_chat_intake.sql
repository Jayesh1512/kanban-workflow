-- Approval-exclusive activation must not turn actionable new-chat prompts into
-- terminal exclusions. Restore every post-activation conversation with live
-- activity to the undecided queue, while preserving explicit rejections and
-- leaving the historical directory excluded.

CREATE TEMP TABLE pending_new_chat_intake ON COMMIT DROP AS
SELECT c.id
FROM chats c
JOIN telegram_conversation_starts scope ON scope.chat_id=c.id
JOIN app_settings activation ON activation.key='telegram:intake:activated'
WHERE c.intake_origin='new'
  AND NOT c.is_control
  AND scope.latest_message_at IS NOT NULL
  AND scope.latest_message_at >= (activation.value->>'at')::timestamptz
  AND NOT EXISTS (
    SELECT 1 FROM chat_intake_requests approved
    WHERE approved.chat_id=c.id
      AND approved.decision='approved'
      AND approved.control_chat_id IS NOT NULL
      AND approved.message_id IS NOT NULL
      AND approved.decided_message_id IS NOT NULL
      AND approved.decided_at IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM chat_intake_requests terminal
    WHERE terminal.chat_id=c.id AND terminal.decision IN ('rejected','cancelled')
  );

UPDATE chats c
SET inclusion='undecided',policy_version=policy_version+1,updated_at=now()
FROM pending_new_chat_intake pending
WHERE c.id=pending.id AND c.inclusion<>'undecided';

INSERT INTO chat_intake_requests(chat_id,policy_version)
SELECT c.id,c.policy_version
FROM chats c JOIN pending_new_chat_intake pending ON pending.id=c.id
WHERE NOT EXISTS (
  SELECT 1 FROM chat_intake_requests request
  WHERE request.chat_id=c.id AND request.decision='pending'
)
ON CONFLICT(chat_id) WHERE decision='pending' DO NOTHING;

-- A prompt sent before the approval-exclusive cleanup retains its Telegram
-- receipt. Rebind only its optimistic policy version to the restored chat.
UPDATE chat_intake_requests request
SET policy_version=c.policy_version,priority_at=now()
FROM chats c JOIN pending_new_chat_intake pending ON pending.id=c.id
WHERE request.chat_id=c.id AND request.decision='pending';

INSERT INTO app_settings(key,value) VALUES(
  'telegram:pending-new-chat-intake-repaired',
  jsonb_build_object('at',now(),'policy','incoming_and_outbound_live_messages')
) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now();
