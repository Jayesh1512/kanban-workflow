-- A person can create a Work card for a conversation the pipeline cannot admit:
-- an excluded chat, or an offline channel such as WhatsApp that has no imported
-- source at all. The card is first-class Work, but its provenance stays honest:
-- it is marked manual and carries the operator's reason. No Telegram message ID
-- and no accepted CRM stage is invented.
--
-- "email" is already accepted by deployed databases; keep it so the widened
-- constraint validates existing rows.
-- Idempotent so a manual apply is safe before the deployment ledger records it.
ALTER TABLE chats DROP CONSTRAINT IF EXISTS chats_kind_check;
ALTER TABLE chats ADD CONSTRAINT chats_kind_check
  CHECK (kind IN ('user','group','supergroup','channel','email','manual'));

-- Manual chats have no upstream identity, so they use their own positive range.
-- Telegram identifiers stay far below it.
CREATE SEQUENCE IF NOT EXISTS manual_chat_ids AS bigint START WITH 900000000000000001;

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS creation_origin text NOT NULL DEFAULT 'pipeline'
    CHECK (creation_origin IN ('pipeline','manual')),
  ADD COLUMN IF NOT EXISTS creation_channel text NOT NULL DEFAULT 'pipeline'
    CHECK (creation_channel IN ('pipeline','manual','whatsapp','email','other')),
  ADD COLUMN IF NOT EXISTS creation_key text,
  ADD COLUMN IF NOT EXISTS creation_note text;
CREATE UNIQUE INDEX IF NOT EXISTS tickets_creation_key ON tickets(creation_key) WHERE creation_key IS NOT NULL;

-- Operator admission for a chat the automatic pipeline never approved. The
-- existing operator audit check already requires a reason and a decided time.
CREATE INDEX IF NOT EXISTS chat_intake_operator_recent
  ON chat_intake_requests(chat_id, decided_at DESC) WHERE decision_origin='operator';
