-- Native board membership is independent of Supabase's user-controlled metadata.
-- auth_user_id is bound only after Supabase verifies the confirmed email.
CREATE TABLE workspace_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid UNIQUE,
  telegram_user_id bigint UNIQUE CHECK(telegram_user_id>0),
  email text NOT NULL UNIQUE CHECK (email=lower(trim(email)) AND length(email)>3),
  display_name text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin','crm_manager','member','viewer')),
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 0 CHECK(version>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE personal_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES workspace_members(id),
  title text NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 500),
  description text NOT NULL DEFAULT '' CHECK(length(description)<=20000),
  lane text NOT NULL DEFAULT 'To be started' REFERENCES lane_definitions(name),
  due_date date,
  version integer NOT NULL DEFAULT 0 CHECK(version>=0),
  creation_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,creation_key)
);
CREATE INDEX personal_tasks_owner ON personal_tasks(owner_id,updated_at DESC,id);
CREATE TABLE workspace_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES workspace_members(id),
  action text NOT NULL,
  resource_id uuid NOT NULL,
  before_value jsonb,
  after_value jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_audit_resource ON workspace_audit(resource_id,created_at DESC);
-- The app accesses these through its server database role. No browser/Data API
-- role can read membership, change roles, or mutate another person's task.
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_audit ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION workspace_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Workspace audit history is immutable'; END $$;
CREATE TRIGGER workspace_audit_immutable BEFORE UPDATE OR DELETE ON workspace_audit
  FOR EACH ROW EXECUTE FUNCTION workspace_audit_immutable();

-- Application SQL runs through the trusted server role, which owns these
-- tables. Keep every existing application table closed to Data API roles too,
-- even if somebody later exposes this schema in Supabase's REST settings.
DO $$
DECLARE relation record;
BEGIN
  FOR relation IN SELECT schemaname,tablename FROM pg_tables WHERE schemaname=current_schema()
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',relation.schemaname,relation.tablename);
  END LOOP;
END $$;
