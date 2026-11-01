-- Scoped MCP access: personal keys per connection (CRM, Tasks, Admin) and
-- emailed admin approval for elevated access. Only key hashes are stored.
CREATE TABLE mcp_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES workspace_members(id),
  surface text NOT NULL CHECK (surface IN ('crm','tasks','admin')),
  level text NOT NULL CHECK (level IN ('propose','full','read')),
  label text NOT NULL DEFAULT '' CHECK (length(label) <= 100),
  key_prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  created_by uuid NOT NULL REFERENCES workspace_members(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  CHECK ((surface='crm' AND level IN ('propose','full')) OR (surface='tasks' AND level IN ('full','read')) OR (surface='admin' AND level='full'))
);
CREATE INDEX mcp_keys_member ON mcp_keys(member_id) WHERE revoked_at IS NULL;

CREATE TABLE mcp_access_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES workspace_members(id),
  key_id uuid REFERENCES mcp_keys(id),
  requested_surface text NOT NULL CHECK (requested_surface IN ('crm','admin')),
  requested_level text NOT NULL DEFAULT 'full' CHECK (requested_level='full'),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  decided_by uuid REFERENCES workspace_members(id),
  decided_at timestamptz,
  token_hash text NOT NULL,
  token_used_at timestamptz,
  email_state text NOT NULL DEFAULT 'pending' CHECK (email_state IN ('pending','sent','not_configured','failed')),
  issued_key_id uuid REFERENCES mcp_keys(id),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '48 hours',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (requested_surface='admin' OR key_id IS NOT NULL)
);
CREATE UNIQUE INDEX mcp_access_requests_one_pending ON mcp_access_requests(member_id, requested_surface) WHERE status='pending';

ALTER TABLE mcp_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_access_requests ENABLE ROW LEVEL SECURITY;

-- CRM notes/workstream changes proposed through MCP land in Approvals like other data changes.
ALTER TABLE outreach_sales_proposals DROP CONSTRAINT outreach_sales_proposals_command_kind_check;
ALTER TABLE outreach_sales_proposals ADD CONSTRAINT outreach_sales_proposals_command_kind_check
  CHECK (command_kind IN ('stage','work','actions','identity','work_actions','fact','details'));
