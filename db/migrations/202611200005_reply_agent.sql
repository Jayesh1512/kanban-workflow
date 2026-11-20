-- Hourly reply agent. It reads recent Telegram group history, asks the model
-- whether the account owner (Ravi/Ravikant) owes a reply, and stores one draft
-- per triggering message. It never sends to the source group and it does not
-- depend on CRM intake, proposals or approval state.

CREATE TABLE reply_scans (
  chat_id bigint PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  -- Highest message ID observed in the fetched window, including own messages.
  last_scanned_message_id integer NOT NULL DEFAULT 0 CHECK (last_scanned_message_id >= 0),
  last_scanned_at timestamptz,
  last_run_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reply_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id bigint NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  chat_title text NOT NULL CHECK (char_length(chat_title) BETWEEN 1 AND 500),
  -- The newest incoming message that triggered this run; the dedupe key.
  trigger_message_id integer NOT NULL CHECK (trigger_message_id > 0),
  first_message_id integer NOT NULL CHECK (first_message_id > 0),
  last_message_id integer NOT NULL CHECK (last_message_id > 0),
  message_count integer NOT NULL CHECK (message_count BETWEEN 1 AND 200),
  addressed_to text NOT NULL CHECK (char_length(addressed_to) BETWEEN 1 AND 120),
  urgency text NOT NULL CHECK (urgency IN ('immediate', 'today', 'later')),
  relevance_reason text NOT NULL CHECK (char_length(relevance_reason) BETWEEN 1 AND 1000),
  suggested_text text NOT NULL CHECK (char_length(suggested_text) BETWEEN 1 AND 4000),
  model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  delivery_message_id integer CHECK (delivery_message_id IS NULL OR delivery_message_id > 0),
  delivery_error text,
  UNIQUE (chat_id, trigger_message_id)
);

CREATE INDEX reply_suggestions_recent ON reply_suggestions(created_at DESC);
CREATE INDEX reply_suggestions_pending_delivery ON reply_suggestions(created_at) WHERE delivered_at IS NULL;
