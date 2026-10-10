-- C4 auth
CREATE TABLE teammate (
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,              -- "scrypt$<saltB64>$<hashB64>", node:crypto scrypt
  created_at TEXT NOT NULL, removed_at TEXT
) STRICT;
CREATE TABLE web_session (
  token_hash TEXT PRIMARY KEY,              -- sha256 hex of the cookie value
  teammate_id INTEGER NOT NULL REFERENCES teammate(id),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL
) STRICT;
CREATE TABLE credential (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,          -- sha256 hex of the secret part
  scope_messages INTEGER NOT NULL DEFAULT 0,
  scope_write INTEGER NOT NULL DEFAULT 0,   -- reserved (R25)
  created_by INTEGER NOT NULL REFERENCES teammate(id),
  created_at TEXT NOT NULL, revoked_at TEXT
) STRICT;
CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;   -- value is JSON

-- C6 graph
CREATE TABLE company (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_norm TEXT NOT NULL UNIQUE,
  merged_into INTEGER REFERENCES company(id),                 -- reserved (R22)
  created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('agent','teammate','credential')),
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE company_alias (
  alias_norm TEXT PRIMARY KEY, alias TEXT NOT NULL,
  company_id INTEGER NOT NULL REFERENCES company(id)
) STRICT;
CREATE TABLE company_not_same (              -- a teammate answered: this name is not that company (R18.7)
  name_norm TEXT NOT NULL, company_id INTEGER NOT NULL REFERENCES company(id),
  PRIMARY KEY (name_norm, company_id)
) STRICT;
CREATE TABLE contact (
  id INTEGER PRIMARY KEY, display_name TEXT NOT NULL,
  name_set_by TEXT NOT NULL DEFAULT 'agent' CHECK (name_set_by IN ('agent','human')),
  role_category TEXT NOT NULL DEFAULT 'unknown', deals_about TEXT NOT NULL DEFAULT '',
  role_set_by TEXT NOT NULL DEFAULT 'agent' CHECK (role_set_by IN ('agent','human')),
  merged_into INTEGER REFERENCES contact(id),                 -- reserved (R22)
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE identity (
  id INTEGER PRIMARY KEY, channel TEXT NOT NULL, user_key TEXT NOT NULL,
  display_name TEXT NOT NULL, handle TEXT,
  contact_id INTEGER REFERENCES contact(id), teammate_id INTEGER REFERENCES teammate(id),
  UNIQUE (channel, user_key),
  CHECK ((contact_id IS NULL) <> (teammate_id IS NULL))   -- exactly one
) STRICT;
CREATE TABLE contact_company (
  contact_id INTEGER NOT NULL REFERENCES contact(id), company_id INTEGER NOT NULL REFERENCES company(id),
  set_by TEXT NOT NULL CHECK (set_by IN ('agent','human')),
  removed INTEGER NOT NULL DEFAULT 0,       -- 1 with set_by='human': a teammate removed it; the agent does not re-add
  PRIMARY KEY (contact_id, company_id)
) STRICT;

-- C8 ingest
CREATE TABLE channel_account (
  id INTEGER PRIMARY KEY, teammate_id INTEGER NOT NULL REFERENCES teammate(id), channel TEXT NOT NULL,
  self_identity_id INTEGER REFERENCES identity(id),
  state TEXT NOT NULL CHECK (state IN ('login','connected','disconnected','auth_lost','removed')),
  include_all INTEGER NOT NULL DEFAULT 0,   -- reserved (R8)
  session_sealed BLOB,                      -- AES-256-GCM of the connector's session; NULL when none
  created_at TEXT NOT NULL,
  UNIQUE (teammate_id, channel)
) STRICT;
CREATE TABLE chat_selection (               -- the only thing stored about a chat that is not included
  account_id INTEGER NOT NULL REFERENCES channel_account(id), chat_key TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('included','excluded','withdrawn')),
  decided_at TEXT NOT NULL,
  PRIMARY KEY (account_id, chat_key)
) STRICT;
CREATE TABLE chat_agreement (               -- history of statements of agreement (R5). Never deleted, by exclusion or by R31 (O1)
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES channel_account(id), channel TEXT NOT NULL, chat_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('confirmed','withdrawn')),
  teammate_id INTEGER NOT NULL REFERENCES teammate(id), at TEXT NOT NULL,
  wording_version INTEGER, wording TEXT     -- the exact statement confirmed; NULL for 'withdrawn'
) STRICT;
CREATE INDEX chat_agreement_chat ON chat_agreement (channel, chat_key, id);
CREATE TABLE chat (
  id INTEGER PRIMARY KEY, channel TEXT NOT NULL, chat_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('direct','group','broadcast')),
  title TEXT NOT NULL,
  named_company_id INTEGER REFERENCES company(id),   -- the company its owner named when including it (R18.8)
  withdrawn_at TEXT, withdrawn_by INTEGER REFERENCES teammate(id),   -- R31
  created_at TEXT NOT NULL,
  UNIQUE (channel, chat_key)
) STRICT;
CREATE TABLE account_chat (                 -- one row per account that has the chat included
  account_id INTEGER NOT NULL REFERENCES channel_account(id), chat_id INTEGER NOT NULL REFERENCES chat(id),
  native_chat_id TEXT NOT NULL,
  live_cursor TEXT,                         -- cursor of the newest message known through this account (3.4)
  sync_state TEXT NOT NULL CHECK (sync_state IN ('idle','syncing','failed')),
  sync_after TEXT,                          -- the 'after' cursor the running fetch began with; kept until it completes (O8)
  sync_since TEXT, sync_limit INTEGER,      -- lower time bound and message cap of the running fetch
  sync_resume TEXT,                         -- connector resume token of the last page stored
  sync_newest TEXT,                         -- cursor of the first (newest) message the running fetch returned
  sync_failed_since TEXT,                   -- first failure of the running fetch; cleared when it completes
  agreement_stale_since TEXT,               -- "confirmation out of date" (R5.7); cleared by a new confirmation
  PRIMARY KEY (account_id, chat_id)
) STRICT;
CREATE TABLE chat_gap (
  id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES channel_account(id),
  chat_id INTEGER NOT NULL REFERENCES chat(id),
  from_time TEXT NOT NULL, to_time TEXT NOT NULL, opened_at TEXT NOT NULL,
  closed_at TEXT,                           -- the missed range was fetched
  abandoned_at TEXT                         -- the host stopped trying; the gap stays shown
) STRICT;
CREATE TABLE chat_participant (
  chat_id INTEGER NOT NULL REFERENCES chat(id), identity_id INTEGER NOT NULL REFERENCES identity(id),
  first_seen_at TEXT NOT NULL,              -- sent_at of the first stored message from this identity in this chat
  PRIMARY KEY (chat_id, identity_id)
) STRICT;
CREATE TABLE message (
  id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL REFERENCES chat(id), message_key TEXT NOT NULL,
  sender_identity_id INTEGER NOT NULL REFERENCES identity(id),
  sent_at TEXT NOT NULL, text TEXT NOT NULL, media TEXT,
  reply_to_message_id INTEGER REFERENCES message(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1, edited_at TEXT, deleted_at TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('live','history')),
  stored_at TEXT NOT NULL,
  processed_version INTEGER NOT NULL DEFAULT 0,          -- pipeline is done with versions <= this
  UNIQUE (chat_id, message_key)
) STRICT;
CREATE INDEX message_pending ON message (chat_id, sent_at, id) WHERE processed_version < version;
CREATE TABLE message_version (              -- earlier texts of an edited message (R10)
  message_id INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, text TEXT NOT NULL, replaced_at TEXT NOT NULL,
  PRIMARY KEY (message_id, version)
) STRICT;
CREATE TABLE message_sighting (             -- which accounts saw the message; links it to teammates (R6.3)
  account_id INTEGER NOT NULL REFERENCES channel_account(id),
  message_id INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  native_id TEXT NOT NULL,
  PRIMARY KEY (account_id, message_id), UNIQUE (account_id, native_id)
) STRICT;
CREATE VIRTUAL TABLE message_fts USING fts5(text, content='message', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2');
-- plus the three standard external-content triggers on message (insert, delete, update of text),
-- and: INSERT INTO message_fts(message_fts, rank) VALUES ('secure-delete', 1);

-- C5 board
CREATE TABLE lane (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, sop TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,       -- +1 on any change to sop, stages or criteria
  position INTEGER NOT NULL, archived_at TEXT, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE stage (
  id INTEGER PRIMARY KEY, lane_id INTEGER NOT NULL REFERENCES lane(id), name TEXT NOT NULL,
  position INTEGER NOT NULL,                -- 0 is the entry stage
  criteria TEXT NOT NULL DEFAULT '', removed_at TEXT,
  UNIQUE (lane_id, name)
) STRICT;
CREATE TABLE card (
  id INTEGER PRIMARY KEY, lane_id INTEGER NOT NULL REFERENCES lane(id), stage_id INTEGER NOT NULL REFERENCES stage(id),
  title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
  text_set_by TEXT NOT NULL DEFAULT 'agent' CHECK (text_set_by IN ('agent','human')),
  needs_text INTEGER NOT NULL DEFAULT 0,    -- 1: title and summary were cleared by a purge and are to be written again (R31)
  company_id INTEGER REFERENCES company(id),
  company_set_by TEXT CHECK (company_set_by IN ('agent','human')),
  created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('agent','teammate','credential')),
  created_from_message_id INTEGER REFERENCES message(id) ON DELETE SET NULL,
  from_history INTEGER NOT NULL DEFAULT 0,
  stage_human_set_at TEXT,                  -- the agent may move the card only on a message sent after this
  last_message_at TEXT,
  last_change_by_kind TEXT NOT NULL CHECK (last_change_by_kind IN ('agent','teammate','credential')),
  archived_at TEXT,
  merged_into INTEGER REFERENCES card(id),  -- reserved (R22)
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE card_chat (                    -- chats that feed the card. Only a teammate adds a second chat (A23)
  card_id INTEGER NOT NULL REFERENCES card(id) ON DELETE CASCADE, chat_id INTEGER NOT NULL REFERENCES chat(id),
  PRIMARY KEY (card_id, chat_id)
) STRICT;
CREATE TABLE card_offer_dismissed (         -- a teammate said this other chat's card is not for this chat (R11.8)
  card_id INTEGER NOT NULL REFERENCES card(id) ON DELETE CASCADE, chat_id INTEGER NOT NULL REFERENCES chat(id),
  PRIMARY KEY (card_id, chat_id)
) STRICT;
CREATE TABLE card_message (
  message_id INTEGER PRIMARY KEY REFERENCES message(id) ON DELETE CASCADE,
  card_id INTEGER REFERENCES card(id) ON DELETE CASCADE,   -- NULL with set_by='human': a teammate said "no card"
  set_by TEXT NOT NULL CHECK (set_by IN ('agent','human'))
) STRICT;
CREATE TABLE note (                         -- reserved (R25)
  id INTEGER PRIMARY KEY, card_id INTEGER REFERENCES card(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contact(id) ON DELETE CASCADE,
  text TEXT NOT NULL, author_kind TEXT NOT NULL, author_id INTEGER, created_at TEXT NOT NULL,
  CHECK ((card_id IS NULL) <> (contact_id IS NULL))
) STRICT;

-- C6 graph, tables that reference message
CREATE TABLE evidence (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('contact_company','contact_role')),
  contact_id INTEGER NOT NULL REFERENCES contact(id) ON DELETE CASCADE, company_id INTEGER REFERENCES company(id),
  message_id INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE company_reference (
  id INTEGER PRIMARY KEY, from_company_id INTEGER REFERENCES company(id),
  to_company_id INTEGER NOT NULL REFERENCES company(id),
  message_id INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  card_id INTEGER REFERENCES card(id) ON DELETE SET NULL,
  removed INTEGER NOT NULL DEFAULT 0,       -- 1: a teammate removed it; reprocessing does not bring it back
  UNIQUE (message_id, to_company_id)
) STRICT;

-- C9 agent
CREATE TABLE decision (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE, message_version INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('applied','review','mixed','none','refused','failed')),
  disposition TEXT NOT NULL, confidence REAL NOT NULL, reason TEXT NOT NULL,
  lane_versions TEXT NOT NULL,              -- JSON {"<laneId>": version} of every lane shown to the model
  model TEXT NOT NULL, raw TEXT NOT NULL,   -- model name; the model's output verbatim
  decided_at TEXT NOT NULL,
  UNIQUE (message_id, message_version)
) STRICT;
CREATE TABLE review_item (                  -- one question about a piece of work, not about a message (O9)
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('new_card','attach','move','is_work','contact_company','contact_role','name_company','model_failed')),
  group_key TEXT NOT NULL,                  -- what makes two decisions "the same question" (3.6)
  chat_id INTEGER REFERENCES chat(id),
  proposal TEXT NOT NULL,                   -- JSON ReviewProposal (3.6)
  why TEXT NOT NULL CHECK (why IN ('low_confidence','cross_chat','cross_lane','human_override','similar_name','model_failed')),
  confidence REAL NOT NULL, reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','accepted','changed','dismissed')),
  result_card_id INTEGER REFERENCES card(id) ON DELETE SET NULL,   -- the card a settled new_card item produced
  resolved_by INTEGER REFERENCES teammate(id), resolved_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX review_one_open ON review_item (kind, group_key) WHERE status = 'open';
CREATE TABLE review_message (               -- the messages an item is about, in the order they joined
  review_item_id INTEGER NOT NULL REFERENCES review_item(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  decision_id INTEGER REFERENCES decision(id) ON DELETE SET NULL,
  PRIMARY KEY (review_item_id, message_id)
) STRICT;
CREATE TABLE pending_mention (              -- a company name that matched nothing yet (R21.5, O6)
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  name TEXT NOT NULL, name_norm TEXT NOT NULL, confidence REAL NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (message_id, name_norm)
) STRICT;

-- C3 log
CREATE TABLE action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('agent','teammate','credential','system')),
  actor_id INTEGER,                         -- teammate.id or credential.id
  action TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id INTEGER,
  before TEXT, after TEXT,                  -- JSON
  reason TEXT NOT NULL DEFAULT '',
  message_ids TEXT NOT NULL DEFAULT '[]',   -- JSON array of message.id
  decision_id INTEGER, corrects_id INTEGER REFERENCES action_log(id),
  follows_human_override INTEGER NOT NULL DEFAULT 0,
  redacted INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TRIGGER action_log_no_delete BEFORE DELETE ON action_log
  BEGIN SELECT RAISE(ABORT, 'action_log is append-only'); END;
CREATE TRIGGER action_log_no_update BEFORE UPDATE ON action_log
  WHEN NOT (OLD.redacted = 0 AND NEW.redacted = 1 AND NEW.id = OLD.id AND NEW.at = OLD.at
            AND NEW.actor_kind = OLD.actor_kind AND NEW.actor_id IS OLD.actor_id
            AND NEW.action = OLD.action AND NEW.subject_kind = OLD.subject_kind
            AND NEW.subject_id IS OLD.subject_id)
  BEGIN SELECT RAISE(ABORT, 'action_log is append-only'); END;

CREATE TRIGGER message_fts_insert AFTER INSERT ON message BEGIN
 INSERT INTO message_fts(rowid,text) VALUES (new.id,new.text);
END;
CREATE TRIGGER message_fts_delete AFTER DELETE ON message BEGIN
 INSERT INTO message_fts(message_fts,rowid,text) VALUES ('delete',old.id,old.text);
END;
CREATE TRIGGER message_fts_update AFTER UPDATE OF text ON message BEGIN
 INSERT INTO message_fts(message_fts,rowid,text) VALUES ('delete',old.id,old.text);
 INSERT INTO message_fts(rowid,text) VALUES (new.id,new.text);
END;
INSERT INTO message_fts(message_fts,rank) VALUES ('secure-delete',1);
