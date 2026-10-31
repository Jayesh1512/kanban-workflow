-- Keep generated Work records and their evidence/history in place. Ownership
-- is independent of CRM authority and source admission.
CREATE FUNCTION workspace_default_work_owner() RETURNS uuid LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT m.id FROM workspace_members m JOIN app_settings s
    ON s.key='workspace:default-work-owner' AND s.value->>'memberId'=m.id::text
$$;
ALTER TABLE tickets ADD COLUMN owner_id uuid REFERENCES workspace_members(id)
  DEFAULT workspace_default_work_owner();
CREATE INDEX tickets_owner ON tickets(owner_id,id);
