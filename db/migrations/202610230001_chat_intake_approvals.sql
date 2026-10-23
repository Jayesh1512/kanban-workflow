-- Chat metadata may be discovered without importing business message content.
CREATE TABLE chat_intake_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id bigint NOT NULL REFERENCES chats(id),
  policy_version integer NOT NULL,
  decision text NOT NULL DEFAULT 'pending' CHECK(decision IN ('pending','approved','rejected','cancelled')),
  priority_at timestamptz NOT NULL DEFAULT now(),
  control_chat_id bigint REFERENCES chats(id),
  random_id bigint NOT NULL DEFAULT hashtextextended(gen_random_uuid()::text,0) UNIQUE CHECK(random_id<>0),
  text text,
  message_id integer,
  delivery_state text NOT NULL DEFAULT 'pending' CHECK(delivery_state IN ('pending','sending','sent','failed')),
  attempts integer NOT NULL DEFAULT 0,
  claim_token uuid,
  lease_until timestamptz,
  last_error text,
  decided_message_id integer,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(control_chat_id,message_id)
);
CREATE UNIQUE INDEX chat_intake_pending_chat ON chat_intake_requests(chat_id) WHERE decision='pending';
CREATE INDEX chat_intake_delivery ON chat_intake_requests(decision,delivery_state,priority_at);
-- Mark the existing directory as historical: never auto-request its admission.
ALTER TABLE chats ADD COLUMN intake_origin text NOT NULL DEFAULT 'new' CHECK(intake_origin IN ('new','historical'));
UPDATE chats SET intake_origin='historical';
INSERT INTO app_settings(key,value) VALUES('telegram:intake:activated',jsonb_build_object('at',now()));
-- Keep existing tracked cards and their policy. Previously auto-included directory
-- entries without a card wait for manual selection; retain all previously stored data.
UPDATE chats SET inclusion='undecided',policy_version=policy_version+1,updated_at=now()
  WHERE inclusion='included' AND NOT is_control AND NOT EXISTS(SELECT 1 FROM tickets WHERE chat_id=chats.id);
UPDATE analysis_jobs SET status='cancelled',worker_id=NULL,lease_until=NULL,last_error='historical_chat_manual_intake',updated_at=now()
  WHERE status NOT IN ('completed','cancelled') AND chat_id IN (SELECT id FROM chats WHERE inclusion='undecided');
UPDATE history_cursors SET status='paused',generation=generation+1,worker_id=NULL,lease_until=NULL
  WHERE chat_id IN (SELECT id FROM chats WHERE inclusion='undecided');
UPDATE telegram_history_requests SET remaining_batches=0 WHERE chat_id IN (SELECT id FROM chats WHERE inclusion='undecided');
UPDATE live_checkpoints SET replay_required=false,generation=generation+1 WHERE chat_id IN (SELECT id FROM chats WHERE inclusion='undecided');
