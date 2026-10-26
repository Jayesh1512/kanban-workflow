-- Additive commercial read model. Operational tickets/lanes remain independent.
CREATE TABLE outreach_stage_definitions (
  id text PRIMARY KEY,
  label text NOT NULL UNIQUE,
  position smallint NOT NULL UNIQUE CHECK(position BETWEEN 0 AND 4)
);
INSERT INTO outreach_stage_definitions VALUES
 ('lead','Lead / Prospect',0),('qualification','Qualification',1),
 ('negotiation','Negotiation',2),('won','Deal Won',3),('archived','Archived',4);

CREATE TABLE outreach_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_key text NOT NULL UNIQUE,
  kind text NOT NULL CHECK(kind IN ('company','contact_prospect')),
  company_id uuid REFERENCES companies(id),
  display_name text NOT NULL CHECK(length(trim(display_name))>0),
  summary text NOT NULL DEFAULT '',
  workstream text REFERENCES workstream_definitions(name),
  accepted_stage text REFERENCES outreach_stage_definitions(id),
  provisional_stage text REFERENCES outreach_stage_definitions(id),
  provisional_reason text,
  provisional_evidence_revision integer,
  stage_version integer NOT NULL DEFAULT 0 CHECK(stage_version>=0),
  identity_version integer NOT NULL DEFAULT 0 CHECK(identity_version>=0),
  evidence_revision integer NOT NULL DEFAULT 0 CHECK(evidence_revision>=0),
  actions_version integer NOT NULL DEFAULT 0 CHECK(actions_version>=0),
  disposition text NOT NULL DEFAULT 'context_review' CHECK(disposition IN ('pipeline','context_review')),
  retained boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((kind='company' AND company_id IS NOT NULL) OR (kind='contact_prospect' AND company_id IS NULL))
);
CREATE UNIQUE INDEX outreach_one_company ON outreach_relationships(company_id) WHERE retained AND company_id IS NOT NULL;
CREATE TABLE outreach_source_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK(kind IN ('telegram','email_report','email')),
  source_key text NOT NULL UNIQUE,
  chat_id bigint UNIQUE REFERENCES chats(id),
  ticket_id uuid UNIQUE REFERENCES tickets(id),
  source_revision text NOT NULL,
  coverage jsonb NOT NULL DEFAULT '{}',
  observed_at timestamptz,
  reconciled_at timestamptz NOT NULL DEFAULT now(),
  CHECK((kind='telegram' AND chat_id IS NOT NULL AND ticket_id IS NOT NULL) OR (kind<>'telegram' AND chat_id IS NULL AND ticket_id IS NULL))
);
CREATE TABLE outreach_relationship_sources (
  source_thread_id uuid PRIMARY KEY REFERENCES outreach_source_threads(id),
  relationship_id uuid NOT NULL REFERENCES outreach_relationships(id),
  enrollment_state text NOT NULL DEFAULT 'pending' CHECK(enrollment_state IN ('pending','active','rejected','suspended')),
  generation integer NOT NULL DEFAULT 1 CHECK(generation>0),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outreach_sources_relationship ON outreach_relationship_sources(relationship_id);
-- A deterministic content manifest, also checked at read time so an edit or
-- exclusion cannot make a previously rendered provisional stage look current.
CREATE VIEW outreach_telegram_inputs AS
SELECT t.id AS ticket_id,c.id AS chat_id,c.title,c.inclusion,c.is_control,
 c.mapping_status,c.company_id AS mapped_company_id,t.company_id,t.kind,
 t.tracking_state,t.lane,t.summary,t.next_action,t.workstream,
 co.canonical_name,co.summary AS company_summary,
 (SELECT max(m.sent_at) FROM messages m WHERE m.chat_id=c.id AND m.deleted_at IS NULL) AS latest_source_at,
 encode(sha256(convert_to(jsonb_build_object(
  'ticket',to_jsonb(t),'chat',to_jsonb(c),'company',to_jsonb(co),
  'messages',(SELECT jsonb_agg(jsonb_build_array(m.id,m.version,m.deleted_at) ORDER BY m.id) FROM messages m WHERE m.chat_id=c.id),
  'evidence',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM evidence e WHERE e.chat_id=c.id),
  'facts',(SELECT jsonb_agg(to_jsonb(f) ORDER BY f.id) FROM facts f WHERE f.ticket_id=t.id),
  'contacts',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM ticket_contacts tc JOIN contacts p ON p.id=tc.contact_id WHERE tc.ticket_id=t.id),
  'roles',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM ticket_contacts tc JOIN contact_company_roles r ON r.contact_id=tc.contact_id WHERE tc.ticket_id=t.id),
  'contact_evidence',(SELECT jsonb_agg(to_jsonb(ce) ORDER BY ce.contact_id,ce.evidence_id) FROM ticket_contacts tc JOIN contact_evidence ce ON ce.contact_id=tc.contact_id WHERE tc.ticket_id=t.id),
  'role_evidence',(SELECT jsonb_agg(to_jsonb(re) ORDER BY re.role_id,re.evidence_id) FROM ticket_contacts tc JOIN contact_company_roles r ON r.contact_id=tc.contact_id JOIN role_evidence re ON re.role_id=r.id WHERE tc.ticket_id=t.id),
  'fact_evidence',(SELECT jsonb_agg(to_jsonb(fe) ORDER BY fe.fact_id,fe.evidence_id) FROM facts f JOIN fact_evidence fe ON fe.fact_id=f.id WHERE f.ticket_id=t.id),
  'company_evidence',(SELECT jsonb_agg(to_jsonb(ce) ORDER BY ce.evidence_id) FROM company_evidence ce WHERE ce.company_id=t.company_id)
 )::text,'UTF8')),'hex') AS source_revision
FROM tickets t JOIN chats c ON c.id=t.chat_id LEFT JOIN companies co ON co.id=t.company_id;
-- M1 intentionally exposes no enrollment/decision/publication writer. Future
-- migrations add their audit records before any source can be activated.
