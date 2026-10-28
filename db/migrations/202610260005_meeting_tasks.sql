-- Meeting actions publish automatically into an existing project. Dispatch is irreversible locally.
CREATE TABLE meeting_task_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id uuid NOT NULL UNIQUE REFERENCES meeting_actions(id),
  action_version integer NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','dispatched','created','unknown','failed','canceled')),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  request_id uuid,
  claim_token uuid,
  dispatched_at timestamptz,
  remote_task_id text,
  remote_url text,
  last_error text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (request_id IS NULL OR state IN ('dispatched','unknown','created'))
);
CREATE INDEX meeting_task_exports_pending ON meeting_task_exports(next_attempt_at,id) WHERE state IN ('queued','failed','dispatched','unknown');
CREATE TABLE meeting_remote_requests (
  id uuid PRIMARY KEY,
  export_id uuid NOT NULL UNIQUE REFERENCES meeting_task_exports(id),
  action_id uuid NOT NULL REFERENCES meeting_actions(id),
  action_version integer NOT NULL,
  marker text NOT NULL,
  snapshot jsonb NOT NULL,
  dispatched_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE meeting_task_exports ADD CONSTRAINT meeting_export_request_fk FOREIGN KEY(request_id) REFERENCES meeting_remote_requests(id);
CREATE TABLE meeting_remote_receipts (
  request_id uuid PRIMARY KEY REFERENCES meeting_remote_requests(id),
  outcome text NOT NULL CHECK(outcome IN ('created','unknown')),
  remote_task_id text,
  remote_url text,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE meeting_task_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  export_id uuid NOT NULL REFERENCES meeting_task_exports(id),
  match_count integer NOT NULL CHECK(match_count>=0),
  matches jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION meeting_immutable_task_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Meeting task request/receipt audit is immutable'; END $$;
CREATE TRIGGER meeting_remote_requests_immutable BEFORE UPDATE OR DELETE ON meeting_remote_requests FOR EACH ROW EXECUTE FUNCTION meeting_immutable_task_audit();
CREATE TRIGGER meeting_remote_receipts_immutable BEFORE UPDATE OR DELETE ON meeting_remote_receipts FOR EACH ROW EXECUTE FUNCTION meeting_immutable_task_audit();
CREATE TRIGGER meeting_task_reconciliations_immutable BEFORE UPDATE OR DELETE ON meeting_task_reconciliations FOR EACH ROW EXECUTE FUNCTION meeting_immutable_task_audit();
