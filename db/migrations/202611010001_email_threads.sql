-- Email threads are chat-backed sources: one thread = one chats row (kind 'email',
-- negative id outside Telegram's range), so intake approval, analysis, CRM and
-- directory reuse the Telegram path unchanged. No history cursor, live checkpoint
-- or conversation-start row exists for them, so no Telegram worker ever selects one.
ALTER TABLE chats DROP CONSTRAINT chats_kind_check;
ALTER TABLE chats ADD CONSTRAINT chats_kind_check CHECK (kind IN ('user','group','supergroup','channel','email'));
CREATE SEQUENCE email_chat_id_seq MINVALUE 1;
CREATE TABLE email_threads (
  thread_key text PRIMARY KEY,
  chat_id bigint NOT NULL UNIQUE REFERENCES chats(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- `pending` holds the message until its thread is approved and it is written to
-- messages; it is NULL afterwards and for rejected threads (content is dropped).
CREATE TABLE email_messages (
  chat_id bigint NOT NULL REFERENCES chats(id),
  message_key text NOT NULL,
  id integer NOT NULL CHECK (id > 0),
  pending jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, message_key),
  UNIQUE (chat_id, id)
);
