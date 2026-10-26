-- Hash business content, not polling timestamps or native projection bookkeeping.
CREATE OR REPLACE VIEW outreach_telegram_inputs AS
SELECT t.id AS ticket_id,c.id AS chat_id,c.title,c.inclusion,c.is_control,
 c.mapping_status,c.company_id AS mapped_company_id,t.company_id,t.kind,
 t.tracking_state,t.lane,t.summary,t.next_action,t.workstream,
 co.canonical_name,co.summary AS company_summary,
 (SELECT max(m.sent_at) FROM messages m WHERE m.chat_id=c.id AND m.deleted_at IS NULL) AS latest_source_at,
 encode(sha256(convert_to(jsonb_build_object(
  'ticket',to_jsonb(t)-ARRAY['created_at','updated_at','vikunja_task_id','lane','stage_version','previous_active_lane'],
  'chat',to_jsonb(c)-ARRAY['discovered_at','updated_at'],
  'company',to_jsonb(co)-ARRAY['created_at','updated_at'],
  'messages',(SELECT jsonb_agg(jsonb_build_array(m.id,m.version,m.deleted_at) ORDER BY m.id) FROM messages m WHERE m.chat_id=c.id),
  'evidence',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM evidence e WHERE e.chat_id=c.id),
  'facts',(SELECT jsonb_agg(to_jsonb(f) ORDER BY f.id) FROM facts f WHERE f.ticket_id=t.id),
  'contacts',(SELECT jsonb_agg(to_jsonb(p)-ARRAY['created_at','updated_at'] ORDER BY p.id) FROM ticket_contacts tc JOIN contacts p ON p.id=tc.contact_id WHERE tc.ticket_id=t.id),
  'roles',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM ticket_contacts tc JOIN contact_company_roles r ON r.contact_id=tc.contact_id WHERE tc.ticket_id=t.id),
  'contact_evidence',(SELECT jsonb_agg(to_jsonb(ce) ORDER BY ce.contact_id,ce.evidence_id) FROM ticket_contacts tc JOIN contact_evidence ce ON ce.contact_id=tc.contact_id WHERE tc.ticket_id=t.id),
  'role_evidence',(SELECT jsonb_agg(to_jsonb(re) ORDER BY re.role_id,re.evidence_id) FROM ticket_contacts tc JOIN contact_company_roles r ON r.contact_id=tc.contact_id JOIN role_evidence re ON re.role_id=r.id WHERE tc.ticket_id=t.id),
  'fact_evidence',(SELECT jsonb_agg(to_jsonb(fe) ORDER BY fe.fact_id,fe.evidence_id) FROM facts f JOIN fact_evidence fe ON fe.fact_id=f.id WHERE f.ticket_id=t.id),
  'company_evidence',(SELECT jsonb_agg(to_jsonb(ce) ORDER BY ce.evidence_id) FROM company_evidence ce WHERE ce.company_id=t.company_id)
 )::text,'UTF8')),'hex') AS source_revision
FROM tickets t JOIN chats c ON c.id=t.chat_id LEFT JOIN companies co ON co.id=t.company_id;
-- M1 intentionally exposes no enrollment/decision/publication writer. Future
-- migrations add their audit records before any source can be activated.
