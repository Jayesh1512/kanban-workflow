CREATE TABLE meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_key text NOT NULL,
  recording_id text NOT NULL,
  current_revision integer NOT NULL DEFAULT 0,
  record jsonb NOT NULL DEFAULT '{}',
  effective_start_at timestamptz,
  source_created_at timestamptz,
  customer_state text NOT NULL DEFAULT 'unresolved' CHECK (customer_state IN ('confirmed','unresolved','ambiguous')),
  mapping_version integer NOT NULL DEFAULT 0,
  mapping_manual boolean NOT NULL DEFAULT false,
  UNIQUE(connection_key,recording_id)
);
CREATE INDEX meetings_start_idx ON meetings(effective_start_at DESC,id DESC);
CREATE TABLE meeting_revisions (
  meeting_id uuid NOT NULL REFERENCES meetings(id),
  revision integer NOT NULL CHECK(revision>0),
  content_hash text NOT NULL,
  raw_payload jsonb NOT NULL,
  normalized jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY(meeting_id,revision)
);
CREATE INDEX meeting_revisions_hash_idx ON meeting_revisions(meeting_id,content_hash);
CREATE TABLE meeting_transcript_segments (
  meeting_id uuid NOT NULL,
  revision integer NOT NULL,
  ordinal integer NOT NULL CHECK(ordinal>=0),
  segment jsonb NOT NULL,
  PRIMARY KEY(meeting_id,revision,ordinal),
  FOREIGN KEY(meeting_id,revision) REFERENCES meeting_revisions(meeting_id,revision)
);
CREATE TABLE meeting_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL REFERENCES meetings(id),
  version integer NOT NULL DEFAULT 1,
  description text NOT NULL,
  assignee jsonb,
  recording_timestamp text,
  playback_url text,
  completed boolean NOT NULL DEFAULT false,
  source_state text NOT NULL CHECK(source_state IN ('current','retired','ambiguous')),
  source_revision integer NOT NULL,
  fingerprint text NOT NULL,
  position integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meeting_actions_meeting_idx ON meeting_actions(meeting_id,source_state);
CREATE TABLE meeting_action_versions (
  action_id uuid NOT NULL REFERENCES meeting_actions(id),
  version integer NOT NULL,
  source_revision integer NOT NULL,
  snapshot jsonb NOT NULL,
  PRIMARY KEY(action_id,version)
);
CREATE TABLE meeting_customer_links (
  meeting_id uuid NOT NULL REFERENCES meetings(id),
  company_id uuid NOT NULL REFERENCES companies(id),
  method text NOT NULL CHECK(method IN ('manual','domain')),
  PRIMARY KEY(meeting_id,company_id)
);
CREATE INDEX meeting_customer_company_idx ON meeting_customer_links(company_id,meeting_id);
CREATE TABLE meeting_customer_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL REFERENCES meetings(id),
  version integer NOT NULL,
  company_ids uuid[] NOT NULL,
  reason text NOT NULL CHECK(length(trim(reason))>0),
  created_at timestamptz NOT NULL,
  UNIQUE(meeting_id,version)
);
CREATE FUNCTION meeting_immutable_source_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Meeting source history is immutable'; END $$;
CREATE TRIGGER meeting_revisions_immutable BEFORE UPDATE OR DELETE ON meeting_revisions FOR EACH ROW EXECUTE FUNCTION meeting_immutable_source_audit();
CREATE TRIGGER meeting_transcript_immutable BEFORE UPDATE OR DELETE ON meeting_transcript_segments FOR EACH ROW EXECUTE FUNCTION meeting_immutable_source_audit();
CREATE TRIGGER meeting_action_versions_immutable BEFORE UPDATE OR DELETE ON meeting_action_versions FOR EACH ROW EXECUTE FUNCTION meeting_immutable_source_audit();
CREATE TRIGGER meeting_customer_corrections_immutable BEFORE UPDATE OR DELETE ON meeting_customer_corrections FOR EACH ROW EXECUTE FUNCTION meeting_immutable_source_audit();
