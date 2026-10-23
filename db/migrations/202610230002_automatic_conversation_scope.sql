CREATE TABLE telegram_conversation_starts (
 chat_id bigint PRIMARY KEY REFERENCES chats(id),
 latest_message_at timestamptz,
 first_message_at timestamptz,
 first_message_id integer,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','checking','qualifies','older','unknown','error')),
 checked_cutoff timestamptz,
 initial_placement_at timestamptz,
 initial_result text CHECK(initial_result IN ('propose','no_change','uncertain')),
 initial_proposal_id uuid REFERENCES proposals(id),
 reason text,
 attempts integer NOT NULL DEFAULT 0,
 claim_token uuid,
 lease_until timestamptz,
 next_check_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO telegram_conversation_starts(chat_id,latest_message_at)
 SELECT c.id,(SELECT max(sent_at) FROM messages m WHERE m.chat_id=c.id AND deleted_at IS NULL) FROM chats c;
CREATE INDEX telegram_conversation_scan ON telegram_conversation_starts(state,next_check_at,lease_until);
-- Automated decisions have their own provenance. Never invent an HTTP operator
-- click, Telegram sender or approval reply for policy-driven movement.
ALTER TABLE proposal_decisions DROP CONSTRAINT proposal_decisions_source_check;
ALTER TABLE proposal_decisions ADD CONSTRAINT proposal_decisions_source_check CHECK(source IN ('telegram','http','mcp','automation'));
