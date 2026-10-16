-- Opt-in only: migrating never configures or moves existing cards/lanes.
ALTER TABLE card ADD COLUMN workflow_version INTEGER NOT NULL DEFAULT 1;
CREATE TABLE workflow_config (
  id INTEGER PRIMARY KEY CHECK (id=1),
  lane_id INTEGER NOT NULL UNIQUE REFERENCES lane(id),
  automatic INTEGER NOT NULL DEFAULT 1 CHECK (automatic IN (0,1)),
  confidence_threshold REAL NOT NULL DEFAULT 0.85 CHECK (confidence_threshold>=0 AND confidence_threshold<=1),
  time_zone TEXT NOT NULL DEFAULT 'Asia/Kolkata'
);
CREATE TABLE workflow_stage (
  key TEXT PRIMARY KEY CHECK (key IN ('to_be_started','work_in_progress','integrations','blocked','completed')),
  stage_id INTEGER NOT NULL UNIQUE REFERENCES stage(id)
);
CREATE TABLE workflow_ticket (
  card_id INTEGER PRIMARY KEY REFERENCES card(id) ON DELETE CASCADE,
  workstream TEXT NOT NULL DEFAULT 'others' CHECK (workstream IN ('buyer','provider','integration','others')),
  next_action TEXT,
  follow_up_at TEXT,
  blocked_reason TEXT,
  buyer_id TEXT
);
-- Any existing owner mutation also invalidates workflow optimistic writes.
CREATE TRIGGER workflow_card_version AFTER UPDATE ON card
WHEN NEW.workflow_version=OLD.workflow_version
BEGIN UPDATE card SET workflow_version=workflow_version+1 WHERE id=NEW.id; END;
CREATE TRIGGER workflow_fields_version AFTER UPDATE ON workflow_ticket
BEGIN UPDATE card SET workflow_version=workflow_version+1 WHERE id=NEW.card_id; END;
CREATE TABLE workflow_field_source (
  card_id INTEGER NOT NULL REFERENCES card(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  human INTEGER NOT NULL CHECK (human IN (0,1)),
  source_message_ids TEXT NOT NULL DEFAULT '[]',
  source_chat_ids TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY(card_id,field)
);
