-- One API-key connection scope; secrets remain in process configuration.
CREATE TABLE meeting_sync_state (
  connection_key text PRIMARY KEY,
  config_fingerprint text NOT NULL,
  auth_paused boolean NOT NULL DEFAULT false,
  next_scan_at timestamptz,
  retry_at timestamptz,
  poll_created_before timestamptz,
  last_success_at timestamptz,
  coverage_created_after timestamptz,
  coverage_created_before timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE meeting_import_runs (
  id uuid PRIMARY KEY,
  connection_key text NOT NULL REFERENCES meeting_sync_state(connection_key),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('manual','poll','webhook')),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','retry','paused','completed','failed')),
  created_after timestamptz NOT NULL,
  created_before timestamptz NOT NULL CHECK(created_before > created_after),
  cursor text,
  cursor_history text[] NOT NULL DEFAULT '{}',
  pages integer NOT NULL DEFAULT 0,
  imported integer NOT NULL DEFAULT 0,
  unchanged integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_until timestamptz,
  retry_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(connection_key,idempotency_key)
);
CREATE INDEX meeting_import_claim ON meeting_import_runs(connection_key,status,created_at);
CREATE TABLE meeting_webhook_inbox (
  id uuid PRIMARY KEY,
  connection_key text NOT NULL DEFAULT 'fathom-default',
  webhook_id text NOT NULL,
  webhook_timestamp bigint NOT NULL,
  body_sha256 text NOT NULL,
  raw_body bytea NOT NULL,
  -- Unrecognized authenticated payloads are evidence, never canonical source content.
  payload jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  run_id uuid REFERENCES meeting_import_runs(id),
  processed_at timestamptz,
  UNIQUE(connection_key,webhook_id)
);
CREATE INDEX meeting_webhook_pending ON meeting_webhook_inbox(received_at) WHERE processed_at IS NULL;
