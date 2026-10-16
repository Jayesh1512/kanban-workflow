-- Telegram operational state; login codes/passwords/API secrets never enter these tables.
ALTER TABLE message_tombstones DROP CONSTRAINT message_tombstones_chat_id_fkey;
CREATE INDEX message_tombstones_message_idx ON message_tombstones(message_id);
CREATE TABLE telegram_history_requests (
  chat_id bigint PRIMARY KEY REFERENCES chats(id),
  batch_size integer NOT NULL CHECK (batch_size BETWEEN 1 AND 100),
  remaining_batches integer NOT NULL CHECK (remaining_batches BETWEEN 0 AND 10000),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE control_setup_operations ADD COLUMN request jsonb NOT NULL DEFAULT '{}';
ALTER TABLE control_outbox ADD COLUMN claim_token uuid;
CREATE TABLE control_inbox (
  chat_id bigint NOT NULL REFERENCES chats(id),
  message_id integer NOT NULL CHECK(message_id > 0),
  sender_id bigint,
  reply_to_id integer CHECK(reply_to_id > 0),
  text text NOT NULL,
  sent_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','done')),
  claim_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  PRIMARY KEY(chat_id,message_id)
);
CREATE INDEX control_inbox_claim_idx ON control_inbox(state,lease_until);
