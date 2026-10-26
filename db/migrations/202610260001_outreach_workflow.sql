-- Commercial decisions and publication are independent of operational tickets.
CREATE TABLE outreach_imports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), namespace text NOT NULL,
 content_hash text NOT NULL, payload jsonb NOT NULL, checked_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'preview' CHECK(state IN ('preview','committed','superseded')),
 supersedes uuid REFERENCES outreach_imports(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(namespace,content_hash)
);
CREATE TABLE outreach_report_context (
 source_id uuid PRIMARY KEY REFERENCES outreach_source_threads(id), import_id uuid NOT NULL REFERENCES outreach_imports(id),
 title text NOT NULL, context jsonb NOT NULL
);
CREATE TABLE outreach_sales_proposals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), relationship_id uuid NOT NULL REFERENCES outreach_relationships(id),
 idempotency_key text NOT NULL UNIQUE, command_hash text NOT NULL, target_stage text NOT NULL REFERENCES outreach_stage_definitions(id),
 reason text NOT NULL, origin text NOT NULL CHECK(origin IN ('manual','hermes','openai','historical_policy')),
 manifest jsonb NOT NULL, input_hash text NOT NULL, context jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected','corrected','stale')),
 created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz
);
CREATE INDEX outreach_pending_proposals ON outreach_sales_proposals(relationship_id,created_at) WHERE state='pending';
CREATE TABLE outreach_sales_decisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), proposal_id uuid NOT NULL UNIQUE REFERENCES outreach_sales_proposals(id),
 idempotency_key text NOT NULL UNIQUE, command_hash text NOT NULL,
 action text NOT NULL CHECK(action IN ('approve','reject','correct')), reason text NOT NULL,
 source text NOT NULL CHECK(source IN ('http','telegram','historical_policy')), provenance jsonb NOT NULL DEFAULT '{}',
 replacement_id uuid REFERENCES outreach_sales_proposals(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE outreach_assessments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), relationship_id uuid NOT NULL REFERENCES outreach_relationships(id),
 input_hash text NOT NULL, rubric_version text NOT NULL, stage text REFERENCES outreach_stage_definitions(id),
 status text NOT NULL CHECK(status IN ('running','complete','unavailable','uncertain','stale')),
 diagnostics jsonb NOT NULL DEFAULT '{}', last_error text, retry_at timestamptz, claim_token uuid,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(relationship_id,input_hash,rubric_version)
);
CREATE TABLE outreach_publications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), relationship_id uuid NOT NULL REFERENCES outreach_relationships(id),
 decision_id uuid NOT NULL REFERENCES outreach_sales_decisions(id), stage text NOT NULL REFERENCES outreach_stage_definitions(id),
 stage_version integer NOT NULL, snapshot jsonb NOT NULL, snapshot_hash text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','published','conflict','superseded')),
 last_error text, created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz,
 UNIQUE(decision_id)
);
CREATE TABLE outreach_board_binding (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), namespace uuid NOT NULL DEFAULT gen_random_uuid(),
 project_id bigint, view_id bigint, buckets jsonb NOT NULL DEFAULT '{}',
 mode text NOT NULL DEFAULT 'observe' CHECK(mode IN ('observe','publish','paused')),
 state text NOT NULL DEFAULT 'pending', last_error text
);
INSERT INTO outreach_board_binding(singleton) VALUES(true);
CREATE TABLE outreach_task_bindings (
 relationship_id uuid PRIMARY KEY REFERENCES outreach_relationships(id), generation integer NOT NULL DEFAULT 1,
 task_id bigint UNIQUE, observed_stage text REFERENCES outreach_stage_definitions(id),
 published_hash text, state text NOT NULL DEFAULT 'pending', last_error text, updated_at timestamptz NOT NULL DEFAULT now()
);
-- A dispatched request is a durable barrier. GET observations do not prove an
-- old request cannot still execute. Only its terminal response releases it.
CREATE TABLE outreach_remote_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), resource_key text NOT NULL, publication_id uuid REFERENCES outreach_publications(id),
 method text NOT NULL CHECK(method IN ('POST','PUT','PATCH','DELETE')), path text NOT NULL, body jsonb,
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','dispatched','remote_unresolved','verified','conflict')),
 response_status integer, response_body jsonb, last_error text,
 created_at timestamptz NOT NULL DEFAULT now(), dispatched_at timestamptz, terminal_at timestamptz
);
CREATE UNIQUE INDEX outreach_one_unresolved_request ON outreach_remote_requests(resource_key)
 WHERE state IN ('prepared','dispatched','remote_unresolved');
CREATE TABLE outreach_remote_receipts (
 request_id uuid PRIMARY KEY REFERENCES outreach_remote_requests(id), status integer NOT NULL, body jsonb,
 received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE outreach_control_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), proposal_id uuid NOT NULL REFERENCES outreach_sales_proposals(id),
 chat_id bigint REFERENCES chats(id), random_id bigint NOT NULL CHECK(random_id<>0), text text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','failed','cancelled')),
 message_id bigint, attempts integer NOT NULL DEFAULT 0, claim_token uuid, lease_until timestamptz,
 last_error text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(proposal_id)
);
CREATE UNIQUE INDEX outreach_control_receipt ON outreach_control_outbox(chat_id,message_id) WHERE message_id IS NOT NULL;
CREATE TABLE outreach_actions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), relationship_id uuid NOT NULL REFERENCES outreach_relationships(id),
 text text NOT NULL, actor text NOT NULL CHECK(actor IN ('antseed','external','unknown')),
 state text NOT NULL CHECK(state IN ('open','completed','cancelled')), precision text NOT NULL CHECK(precision IN ('none','date','instant')),
 local_date date, instant timestamptz, timezone text NOT NULL DEFAULT 'Asia/Kolkata', version integer NOT NULL DEFAULT 0,
 origin text NOT NULL DEFAULT 'manual', evidence_refs jsonb NOT NULL DEFAULT '[]',
 CHECK((precision='none' AND local_date IS NULL AND instant IS NULL) OR
 (precision='date' AND local_date IS NOT NULL AND instant IS NULL) OR (precision='instant' AND instant IS NOT NULL AND local_date IS NULL))
);
CREATE TABLE outreach_identity_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), relationship_id uuid NOT NULL REFERENCES outreach_relationships(id),
 reason text NOT NULL, before_value jsonb NOT NULL, after_value jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE outreach_retirements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), relationship_id uuid NOT NULL REFERENCES outreach_relationships(id),
 task_id bigint NOT NULL, generation integer NOT NULL, reason text NOT NULL, snapshot jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','retired','conflict')),
 created_at timestamptz NOT NULL DEFAULT now(), retired_at timestamptz, UNIQUE(task_id)
);
CREATE TABLE outreach_detail_refresh (
 relationship_id uuid PRIMARY KEY REFERENCES outreach_relationships(id),
 reason text NOT NULL, last_error text, revision uuid NOT NULL DEFAULT gen_random_uuid(), updated_at timestamptz NOT NULL DEFAULT now()
);
