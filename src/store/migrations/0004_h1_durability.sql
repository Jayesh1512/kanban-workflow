ALTER TABLE message_sighting ADD COLUMN reply_to_native_id TEXT DEFAULT NULL;
CREATE INDEX message_sighting_pending_reply
  ON message_sighting(account_id, reply_to_native_id)
  WHERE reply_to_native_id IS NOT NULL;

ALTER TABLE account_chat ADD COLUMN sync_gap_from TEXT DEFAULT NULL;
ALTER TABLE account_chat ADD COLUMN sync_origin_state TEXT NOT NULL DEFAULT 'none'
  CHECK (sync_origin_state IN ('none','queued','captured','legacy_unknown'))
  CHECK (
    (sync_origin_state = 'captured' AND sync_gap_from IS NOT NULL)
    OR (sync_origin_state <> 'captured' AND sync_gap_from IS NULL)
  );
UPDATE account_chat SET sync_origin_state='legacy_unknown'
  WHERE sync_state <> 'idle';

ALTER TABLE chat_gap ADD COLUMN bound_provenance TEXT NOT NULL DEFAULT 'legacy_unknown'
  CHECK (bound_provenance IN ('exact','legacy_unknown'));
