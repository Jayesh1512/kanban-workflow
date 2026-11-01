-- Telegram basic group -> supergroup upgrades give the conversation a new chat
-- ID. Record the predecessor/successor pair so the successor inherits the
-- predecessor's admission, mapping and CRM relationship instead of becoming a
-- duplicate deal. Either chat may be discovered first, so neither side has a
-- foreign key; chats themselves are never altered or deleted.
CREATE TABLE chat_migrations (
  predecessor_chat_id bigint PRIMARY KEY,
  successor_chat_id bigint NOT NULL UNIQUE,
  detected_via text NOT NULL CHECK (detected_via IN ('dialog','full_chat','service_message')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (predecessor_chat_id <> successor_chat_id)
);

ALTER TABLE chat_migrations ENABLE ROW LEVEL SECURITY;
