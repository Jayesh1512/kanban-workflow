-- Telegram intake admits a CRM conversation. Work is an explicitly approved
-- action downstream of that relationship, never a prerequisite for its data.
ALTER TABLE outreach_source_threads DROP CONSTRAINT outreach_source_threads_check;
ALTER TABLE outreach_source_threads ADD CONSTRAINT outreach_source_threads_check
  CHECK ((kind='telegram' AND chat_id IS NOT NULL) OR
         (kind<>'telegram' AND chat_id IS NULL AND ticket_id IS NULL));

ALTER TABLE outreach_sales_proposals
  ADD COLUMN command_kind text NOT NULL DEFAULT 'stage'
    CHECK(command_kind IN ('stage','work','actions','identity','work_actions','fact')),
  ADD COLUMN command_payload jsonb NOT NULL DEFAULT '{}';

ALTER TABLE tickets
  ADD COLUMN crm_relationship_id uuid REFERENCES outreach_relationships(id),
  ADD COLUMN creation_proposal_id uuid UNIQUE REFERENCES outreach_sales_proposals(id);
-- Preserve historical cards. Each new approved action may create its own task,
-- including several actions from the same CRM conversation.
ALTER TABLE tickets DROP CONSTRAINT tickets_chat_id_key;
CREATE UNIQUE INDEX tickets_legacy_chat ON tickets(chat_id) WHERE creation_proposal_id IS NULL;
CREATE INDEX tickets_crm_relationship ON tickets(crm_relationship_id);
UPDATE tickets t SET crm_relationship_id=rs.relationship_id
  FROM outreach_source_threads s JOIN outreach_relationship_sources rs ON rs.source_thread_id=s.id
  WHERE s.ticket_id=t.id;

CREATE OR REPLACE VIEW outreach_telegram_inputs AS
SELECT legacy.id AS ticket_id,c.id AS chat_id,c.title,c.inclusion,c.is_control,
 c.mapping_status,c.company_id AS mapped_company_id,c.company_id,
 CASE WHEN c.company_id IS NULL THEN 'contact_prospect' ELSE 'company' END AS kind,
 CASE WHEN c.inclusion='included' AND NOT c.is_control AND c.mapping_status<>'non_company'
   THEN 'active' ELSE 'suspended' END AS tracking_state,
 legacy.lane,coalesce(analysis.extraction->>'summary','') AS summary,
 NULL::text AS next_action,coalesce(co.workstream,'Others') AS workstream,
 co.canonical_name,co.summary AS company_summary,
 (SELECT max(m.sent_at) FROM messages m WHERE m.chat_id=c.id AND m.deleted_at IS NULL) AS latest_source_at,
 encode(sha256(convert_to(jsonb_build_object(
  'chat',to_jsonb(c)-ARRAY['discovered_at','updated_at'],
  'company',to_jsonb(co)-ARRAY['created_at','updated_at'],
  'messages',(SELECT jsonb_agg(jsonb_build_array(m.id,m.version,m.deleted_at) ORDER BY m.id) FROM messages m WHERE m.chat_id=c.id),
  'evidence',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM evidence e WHERE e.chat_id=c.id),
  'facts',(SELECT jsonb_agg(to_jsonb(f)-ARRAY['ticket_id'] ORDER BY f.id) FROM facts f JOIN analysis_jobs j ON j.id=f.job_id WHERE j.chat_id=c.id),
  'contacts',(SELECT jsonb_agg(to_jsonb(p)-ARRAY['created_at','updated_at'] ORDER BY p.id) FROM contacts p
    WHERE EXISTS(SELECT 1 FROM contact_evidence ce JOIN evidence e ON e.id=ce.evidence_id WHERE ce.contact_id=p.id AND e.chat_id=c.id)),
  'contact_evidence',(SELECT jsonb_agg(to_jsonb(ce) ORDER BY ce.contact_id,ce.evidence_id) FROM contact_evidence ce JOIN evidence e ON e.id=ce.evidence_id WHERE e.chat_id=c.id),
  'roles',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM contact_company_roles r WHERE EXISTS(
    SELECT 1 FROM role_evidence re JOIN evidence e ON e.id=re.evidence_id WHERE re.role_id=r.id AND e.chat_id=c.id)),
  'role_evidence',(SELECT jsonb_agg(to_jsonb(re) ORDER BY re.role_id,re.evidence_id) FROM role_evidence re JOIN evidence e ON e.id=re.evidence_id WHERE e.chat_id=c.id),
  'company_evidence',(SELECT jsonb_agg(to_jsonb(ce) ORDER BY ce.evidence_id) FROM company_evidence ce WHERE ce.company_id=c.company_id)
 )::text,'UTF8')),'hex') AS source_revision
FROM chats c LEFT JOIN companies co ON co.id=c.company_id
LEFT JOIN LATERAL (SELECT t.id,t.lane FROM tickets t WHERE t.chat_id=c.id
  ORDER BY t.created_at,t.id LIMIT 1) legacy ON true
LEFT JOIN LATERAL (SELECT j.extraction FROM analysis_jobs j WHERE j.chat_id=c.id AND j.status='completed'
  ORDER BY j.updated_at DESC,j.id LIMIT 1) analysis ON true;

INSERT INTO app_settings(key,value) VALUES('workflow:crm-first','{"enabled":true}'::jsonb)
  ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now();
-- Retire the old one-off initial-placement exception: admission and movement
-- now always have separate Telegram approval boundaries.
INSERT INTO app_settings(key,value) VALUES('telegram:approval-exclusive-sources','{"enabled":true}'::jsonb)
  ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now();
