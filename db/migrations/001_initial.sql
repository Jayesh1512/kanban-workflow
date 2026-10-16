-- PostgreSQL 17+, application database only; Vikunja uses a separate database.
-- Runner owns transaction + advisory lock + schema_migrations checksum (see ARCHITECTURE).
CREATE TABLE lane_definitions (
  name text PRIMARY KEY,
  position smallint NOT NULL UNIQUE CHECK (position BETWEEN 0 AND 5)
);
INSERT INTO lane_definitions VALUES
  ('To be started', 0), ('Work in progress', 1), ('Integrations', 2),
  ('Blocked', 3), ('Archived', 4), ('Completed', 5);
CREATE TABLE workstream_definitions (name text PRIMARY KEY);
INSERT INTO workstream_definitions VALUES ('Buyer'), ('Provider'), ('Integration'), ('Others');
CREATE TABLE telegram_account (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  self_user_id bigint NOT NULL UNIQUE CHECK (self_user_id > 0),
  bound_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name text NOT NULL CHECK (length(trim(canonical_name)) > 0),
  aliases text[] NOT NULL DEFAULT '{}',
  domains text[] NOT NULL DEFAULT '{}',
  workstream text REFERENCES workstream_definitions(name),
  summary text NOT NULL DEFAULT '',
  buyer_ids text[] NOT NULL DEFAULT '{}',
  provider_ids text[] NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Names/aliases/domains deliberately nonunique: collisions must surface as ambiguity.
CREATE INDEX companies_name_idx ON companies (lower(canonical_name));
CREATE INDEX companies_aliases_idx ON companies USING gin (aliases);
CREATE INDEX companies_domains_idx ON companies USING gin (domains);
CREATE TABLE chats (
  id bigint PRIMARY KEY CHECK (id <> 0),
  kind text NOT NULL CHECK (kind IN ('user','group','supergroup','channel')),
  title text NOT NULL,
  username text,
  archived boolean NOT NULL DEFAULT false,
  inclusion text NOT NULL DEFAULT 'undecided' CHECK (inclusion IN ('undecided','included','excluded')),
  is_control boolean NOT NULL DEFAULT false,
  policy_version integer NOT NULL DEFAULT 0 CHECK (policy_version >= 0),
  mapping_status text NOT NULL DEFAULT 'unresolved' CHECK (mapping_status IN ('unresolved','ambiguous','confirmed','non_company')),
  company_id uuid REFERENCES companies(id),
  mapping_version integer NOT NULL DEFAULT 0 CHECK (mapping_version >= 0),
  discovered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((mapping_status = 'confirmed') = (company_id IS NOT NULL)),
  CHECK (NOT is_control OR inclusion = 'excluded')
);
CREATE UNIQUE INDEX one_control_chat_idx ON chats (is_control) WHERE is_control;
CREATE TABLE history_cursors (
  chat_id bigint PRIMARY KEY REFERENCES chats(id),
  next_message_id integer CHECK (next_message_id > 0),
  next_date timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','paused','complete','error')),
  imported_count bigint NOT NULL DEFAULT 0 CHECK (imported_count >= 0),
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((next_message_id IS NULL) = (next_date IS NULL))
);
ALTER TABLE history_cursors ADD COLUMN generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0);
ALTER TABLE history_cursors ADD COLUMN worker_id text;
ALTER TABLE history_cursors ADD COLUMN lease_until timestamptz;
CREATE TABLE live_checkpoints (
  chat_id bigint PRIMARY KEY REFERENCES chats(id),
  high_water_message_id integer CHECK (high_water_message_id > 0),
  reconciled_at timestamptz,
  replay_required boolean NOT NULL DEFAULT true,
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0)
);
-- NULL scope means common nonchannel mailbox; resolve only against user/group chats.
CREATE TABLE message_tombstones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id bigint REFERENCES chats(id),
  message_id integer NOT NULL CHECK (message_id > 0),
  observed_at timestamptz NOT NULL,
  UNIQUE NULLS NOT DISTINCT (chat_id,message_id)
);
CREATE TABLE messages (
  chat_id bigint NOT NULL REFERENCES chats(id),
  id integer NOT NULL CHECK (id > 0),
  sender_id bigint,
  sent_at timestamptz NOT NULL,
  edited_at timestamptz,
  deleted_at timestamptz,
  text text NOT NULL DEFAULT '',
  reply_to_id integer CHECK (reply_to_id > 0),
  source_url text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  sender_snapshot jsonb NOT NULL DEFAULT '{}',
  peer_snapshot jsonb NOT NULL DEFAULT '{}',
  forward_metadata jsonb NOT NULL DEFAULT '{"isForwarded":false,"sourceKind":"unknown","originPeer":null,"originName":null,"originDate":null,"originMessageId":null}',
  PRIMARY KEY (chat_id, id)
);
CREATE INDEX messages_time_idx ON messages (chat_id, sent_at DESC);
CREATE INDEX messages_mailbox_id_idx ON messages (id); -- filter joined chats.kind for channelId=null deletions
CREATE TABLE evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id bigint NOT NULL,
  message_id integer NOT NULL,
  message_version integer NOT NULL CHECK (message_version > 0),
  excerpt text NOT NULL,
  source_url text,
  observed_at timestamptz NOT NULL,
  invalidated_at timestamptz,
  FOREIGN KEY (chat_id, message_id) REFERENCES messages(chat_id, id),
  UNIQUE (chat_id, message_id, message_version, id)
);
CREATE INDEX evidence_message_idx ON evidence (chat_id, message_id, message_version);
CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  names text[] NOT NULL DEFAULT '{}',
  usernames text[] NOT NULL DEFAULT '{}',
  phones text[] NOT NULL DEFAULT '{}',
  emails text[] NOT NULL DEFAULT '{}',
  affiliation text NOT NULL DEFAULT 'unknown' CHECK (affiliation IN ('internal','external','unknown')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE contact_telegram_ids (
  telegram_user_id bigint PRIMARY KEY CHECK (telegram_user_id > 0),
  contact_id uuid NOT NULL REFERENCES contacts(id)
);
CREATE TABLE company_evidence (company_id uuid REFERENCES companies(id), evidence_id uuid REFERENCES evidence(id), PRIMARY KEY (company_id,evidence_id));
CREATE TABLE contact_evidence (contact_id uuid REFERENCES contacts(id), evidence_id uuid REFERENCES evidence(id), PRIMARY KEY (contact_id,evidence_id));
CREATE TABLE contact_company_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES contacts(id),
  company_id uuid NOT NULL REFERENCES companies(id),
  role text NOT NULL CHECK (length(trim(role)) > 0),
  UNIQUE (contact_id,company_id,role)
);
CREATE TABLE role_evidence (role_id uuid REFERENCES contact_company_roles(id), evidence_id uuid REFERENCES evidence(id), PRIMARY KEY (role_id,evidence_id));
CREATE TABLE mapping_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id bigint NOT NULL REFERENCES chats(id),
  company_id uuid REFERENCES companies(id),
  canonical_name text NOT NULL,
  confidence double precision NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  mapping_version integer NOT NULL CHECK (mapping_version >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mapping_candidate_evidence (candidate_id uuid REFERENCES mapping_candidates(id), evidence_id uuid REFERENCES evidence(id), PRIMARY KEY (candidate_id,evidence_id));
CREATE TABLE mapping_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id bigint NOT NULL REFERENCES chats(id),
  company_id uuid REFERENCES companies(id),
  mapping_status text NOT NULL CHECK (mapping_status IN ('unresolved','ambiguous','confirmed','non_company')),
  version integer NOT NULL CHECK (version >= 0),
  reason text NOT NULL,
  source text NOT NULL CHECK (source IN ('http','mcp','telegram','analysis')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chat_id,version),
  CHECK ((mapping_status = 'confirmed') = (company_id IS NOT NULL))
);
CREATE TABLE mapping_history_evidence (history_id uuid REFERENCES mapping_history(id), evidence_id uuid REFERENCES evidence(id), PRIMARY KEY (history_id,evidence_id));
CREATE TABLE tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id bigint NOT NULL UNIQUE REFERENCES chats(id),
  company_id uuid NOT NULL REFERENCES companies(id),
  vikunja_task_id bigint UNIQUE CHECK (vikunja_task_id > 0),
  lane text NOT NULL DEFAULT 'To be started' REFERENCES lane_definitions(name),
  stage_version integer NOT NULL DEFAULT 0 CHECK (stage_version >= 0),
  previous_active_lane text REFERENCES lane_definitions(name),
  workstream text NOT NULL DEFAULT 'Others' REFERENCES workstream_definitions(name),
  summary text NOT NULL DEFAULT '',
  next_action text,
  follow_up_at timestamptz,
  eta_at timestamptz,
  latest_substantive_at timestamptz,
  blockers text[] NOT NULL DEFAULT '{}',
  actions_version integer NOT NULL DEFAULT 0 CHECK (actions_version >= 0),
  actions_source text NOT NULL DEFAULT 'inferred' CHECK (actions_source IN ('manual','inferred')),
  tracking_state text NOT NULL DEFAULT 'active' CHECK (tracking_state IN ('active','suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (previous_active_lane IS NULL OR previous_active_lane IN ('To be started','Work in progress','Integrations'))
);
CREATE INDEX tickets_follow_up_idx ON tickets (follow_up_at) WHERE follow_up_at IS NOT NULL;
CREATE TABLE ticket_contacts (ticket_id uuid REFERENCES tickets(id), contact_id uuid REFERENCES contacts(id), PRIMARY KEY (ticket_id,contact_id));
CREATE TABLE ticket_evidence (ticket_id uuid REFERENCES tickets(id), evidence_id uuid REFERENCES evidence(id), PRIMARY KEY (ticket_id,evidence_id));
CREATE TABLE analysis_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id bigint NOT NULL REFERENCES chats(id),
  policy_version integer NOT NULL CHECK (policy_version >= 0),
  mapping_version integer NOT NULL CHECK (mapping_version >= 0),
  dedupe_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','provider_unavailable','retry','completed','cancelled')),
  extraction jsonb,
  decision jsonb,
  extraction_provenance jsonb,
  extraction_input_hash text,
  jev_provenance jsonb,
  jev_diagnostics jsonb,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  worker_id text,
  lease_until timestamptz,
  retry_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX analysis_jobs_claim_idx ON analysis_jobs (status,retry_at,created_at);
CREATE TABLE analysis_job_messages (
  job_id uuid REFERENCES analysis_jobs(id),
  chat_id bigint NOT NULL,
  message_id integer NOT NULL,
  message_version integer NOT NULL CHECK (message_version > 0),
  PRIMARY KEY (job_id,chat_id,message_id),
  FOREIGN KEY (chat_id,message_id) REFERENCES messages(chat_id,id)
);
CREATE TABLE facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES analysis_jobs(id),
  ticket_id uuid REFERENCES tickets(id),
  kind text NOT NULL CHECK (kind IN ('fact','action','question','blocker','commitment','follow_up','eta')),
  text text NOT NULL,
  relative_to timestamptz,
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  resolved_at timestamptz,
  ambiguous boolean NOT NULL DEFAULT false,
  parent_fact_id uuid REFERENCES facts(id), -- dated child rows attach to their action/commitment/question
  actor_party text NOT NULL DEFAULT 'unknown' CHECK (actor_party IN ('antseed','external','unknown')),
  actor_contact_id uuid REFERENCES contacts(id),
  actor_display_name text,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','answered','completed','withdrawn')),
  source text NOT NULL DEFAULT 'inferred' CHECK (source IN ('manual','inferred')),
  answers_fact_id uuid REFERENCES facts(id),
  local_date date,
  date_precision text NOT NULL DEFAULT 'unresolved' CHECK (date_precision IN ('instant','date','unresolved')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  CHECK ((date_precision = 'instant' AND resolved_at IS NOT NULL AND local_date IS NULL) OR (date_precision = 'date' AND local_date IS NOT NULL AND resolved_at IS NULL) OR (date_precision = 'unresolved' AND resolved_at IS NULL AND local_date IS NULL)),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE fact_evidence (fact_id uuid REFERENCES facts(id), evidence_id uuid REFERENCES evidence(id), PRIMARY KEY (fact_id,evidence_id));
CREATE TABLE proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id),
  source_lane text NOT NULL REFERENCES lane_definitions(name),
  source_stage_version integer NOT NULL CHECK (source_stage_version >= 0),
  source_mapping_version integer NOT NULL CHECK (source_mapping_version >= 0),
  source_policy_version integer NOT NULL CHECK (source_policy_version >= 0),
  target_lane text NOT NULL REFERENCES lane_definitions(name),
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  next_action text,
  origin text NOT NULL CHECK (origin IN ('jev','hermes','manual')),
  decision text NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending','approved','rejected','corrected')),
  apply_state text NOT NULL DEFAULT 'not_requested' CHECK (apply_state IN ('not_requested','queued','applying','reconciling','applied','stale','failed')),
  correction_of uuid UNIQUE REFERENCES proposals(id),
  decided_at timestamptz,
  applied_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_lane <> target_lane),
  UNIQUE (id,ticket_id),
  CHECK ((decision = 'pending') = (decided_at IS NULL)),
  CHECK (decision = 'approved' OR apply_state IN ('not_requested','stale')),
  CHECK ((apply_state = 'applied') = (applied_at IS NOT NULL))
);
CREATE INDEX proposals_ticket_idx ON proposals (ticket_id,created_at DESC);
CREATE TABLE proposal_evidence (proposal_id uuid REFERENCES proposals(id), evidence_id uuid REFERENCES evidence(id), PRIMARY KEY (proposal_id,evidence_id));
CREATE TABLE proposal_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES proposals(id),
  idempotency_key text NOT NULL UNIQUE,
  decision text NOT NULL CHECK (decision IN ('approve','reject','correct')),
  source text NOT NULL CHECK (source IN ('telegram','http','mcp')),
  control_chat_id bigint REFERENCES chats(id),
  control_message_id integer,
  sender_id bigint,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (control_chat_id,control_message_id)
);
CREATE TABLE mutations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL UNIQUE REFERENCES proposals(id),
  ticket_id uuid NOT NULL REFERENCES tickets(id),
  task_id bigint NOT NULL CHECK (task_id > 0),
  project_id bigint NOT NULL CHECK (project_id > 0),
  view_id bigint NOT NULL CHECK (view_id > 0),
  source_bucket_id bigint NOT NULL CHECK (source_bucket_id > 0),
  target_bucket_id bigint NOT NULL CHECK (target_bucket_id > 0),
  state text NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','remote_unknown','remote_confirmed','committed','conflict')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  worker_id text,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_bucket_id <> target_bucket_id),
  FOREIGN KEY (proposal_id,ticket_id) REFERENCES proposals(id,ticket_id)
);
CREATE UNIQUE INDEX one_active_mutation_per_ticket ON mutations (ticket_id) WHERE state IN ('prepared','remote_unknown','remote_confirmed');
CREATE INDEX mutations_claim_idx ON mutations (state,lease_until,created_at);
CREATE TABLE control_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES proposals(id),
  chat_id bigint NOT NULL REFERENCES chats(id),
  random_id bigint NOT NULL UNIQUE CHECK (random_id <> 0), -- stable MTProto send randomId across retries
  text text NOT NULL,
  message_id integer CHECK (message_id > 0),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','sent','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (proposal_id,chat_id),
  UNIQUE (chat_id,message_id),
  CHECK (state <> 'sent' OR message_id IS NOT NULL)
);
CREATE INDEX control_outbox_claim_idx ON control_outbox (state,lease_until,created_at);
CREATE TABLE control_setup_operations (
  operation_key text PRIMARY KEY,
  request_hash text NOT NULL,
  marker text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','remote_unknown','configured','conflict','failed')),
  chat_id bigint REFERENCES chats(id),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state <> 'configured' OR chat_id IS NOT NULL)
);
CREATE TABLE idempotency_keys (
  scope text NOT NULL,
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope,key)
);
CREATE TABLE board_bindings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  project_id bigint NOT NULL CHECK (project_id > 0),
  view_id bigint NOT NULL CHECK (view_id > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE board_buckets (lane text PRIMARY KEY REFERENCES lane_definitions(name), bucket_id bigint NOT NULL UNIQUE CHECK (bucket_id > 0));
CREATE TABLE board_labels (workstream text PRIMARY KEY REFERENCES workstream_definitions(name), label_id bigint NOT NULL UNIQUE CHECK (label_id > 0));
CREATE TABLE app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_settings (key,value) VALUES ('timezone','"Asia/Kolkata"');
