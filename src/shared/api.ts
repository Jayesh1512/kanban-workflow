/** Transport bindings share the service methods in ports.ts; no direct SQL or upstream calls. */
export const API_OPERATIONS = [
  { method: 'POST', path: '/api/outreach/relationships/:relationshipId/work', tool: 'propose_crm_work', service: 'outreach.proposeWork' },
  { method: 'GET', path: '/api/outreach/relationships', tool: 'list_outreach_relationships', service: 'outreach.list' },
  { method: 'GET', path: '/api/outreach/relationships/:id', tool: 'get_outreach_relationship', service: 'outreach.get' },
  { method: 'POST', path: '/api/outreach/proposals', tool: 'propose_sales_stage', service: 'outreach.propose' },
  { method: 'GET', path: '/api/outreach/proposals', tool: 'list_sales_proposals', service: 'outreach.listProposals' },
  { method: 'GET', path: '/api/outreach/proposals/:id', tool: 'get_sales_proposal', service: 'outreach.getProposal' },
  { method: 'POST', path: '/api/outreach/proposals/:proposalId/decision', tool: null, service: 'outreach.decide' },
  { method: 'POST', path: '/api/outreach/imports/preview', tool: null, service: 'outreach.previewImport' },
  { method: 'POST', path: '/api/outreach/imports/:id/commit', tool: null, service: 'outreach.commitImport' },
  { method: 'GET', path: '/api/outreach/imports/:id', tool: null, service: 'outreach.getImport' },
  { method: 'PUT', path: '/api/outreach/relationships/:relationshipId/actions', tool: 'update_sales_actions', service: 'outreach.updateActions' },
  { method: 'POST', path: '/api/outreach/relationships/:relationshipId/assess', tool: 'assess_sales_relationship', service: 'outreach.assess' },
  { method: 'PUT', path: '/api/outreach/relationships/:relationshipId/identity', tool: 'correct_sales_identity', service: 'outreach.correctIdentity' },
  { method: 'PUT', path: '/api/outreach/mode', tool: null, service: 'outreach.setMode' },
  { method: 'GET', path: '/api/outreach/status', tool: 'get_sales_status', service: 'outreach.status' },
  { method: 'GET', path: '/api/chats', tool: 'list_chats', service: 'chats.list' },
  { method: 'PUT', path: '/api/chats/:chatId/inclusion', tool: 'set_chat_inclusion', service: 'chats.setInclusion' },
  { method: 'GET', path: '/api/chats/:chatId/import', tool: 'get_import_status', service: 'chats.importStatus' },
  { method: 'POST', path: '/api/chats/:chatId/import', tool: 'request_import', service: 'chats.requestImport' },
  { method: 'GET', path: '/api/chats/:chatId/mapping', tool: 'get_mapping_candidates', service: 'chats.mappingCandidates' },
  { method: 'PUT', path: '/api/chats/:chatId/mapping', tool: 'correct_company_mapping', service: 'chats.correctMapping' },
  { method: 'GET', path: '/api/companies', tool: 'list_companies', service: 'records.listCompanies' },
  { method: 'GET', path: '/api/companies/:id', tool: 'get_company', service: 'records.getCompany' },
  { method: 'POST', path: '/api/companies', tool: 'create_company', service: 'records.createCompany' },
  { method: 'PUT', path: '/api/companies/:id', tool: 'update_company', service: 'records.updateCompany' },
  { method: 'GET', path: '/api/contacts', tool: 'list_contacts', service: 'records.listContacts' },
  { method: 'GET', path: '/api/contacts/:id', tool: 'get_contact', service: 'records.getContact' },
  { method: 'POST', path: '/api/contacts', tool: 'create_contact', service: 'records.createContact' },
  { method: 'PUT', path: '/api/contacts/:id', tool: 'update_contact', service: 'records.updateContact' },
  { method: 'GET', path: '/api/tickets', tool: 'list_tickets', service: 'records.listTickets' },
  { method: 'GET', path: '/api/tickets/:id', tool: 'get_ticket', service: 'records.getTicket' },
  { method: 'POST', path: '/api/tickets', tool: 'ensure_ticket', service: 'records.ensureTicket' },
  { method: 'GET', path: '/api/tickets/:ticketId/context', tool: 'get_ticket_context', service: 'records.getContext' },
  { method: 'POST', path: '/api/evidence/query', tool: 'get_evidence', service: 'records.getEvidence' },
  { method: 'PUT', path: '/api/tickets/:ticketId/actions', tool: 'update_ticket_actions', service: 'records.updateActions' },
  { method: 'GET', path: '/api/tickets/:ticketId/facts', tool: 'list_ticket_facts', service: 'records.listFacts' },
  { method: 'PUT', path: '/api/facts/:factId', tool: 'update_fact', service: 'records.updateFact' },
  { method: 'GET', path: '/api/priorities/today', tool: 'today_priorities', service: 'records.priorities' },
  { method: 'POST', path: '/api/proposals', tool: 'propose_lane_change', service: 'proposals.propose' },
  { method: 'GET', path: '/api/proposals', tool: 'list_proposals', service: 'proposals.list' },
  { method: 'GET', path: '/api/proposals/:id', tool: 'get_proposal', service: 'proposals.get' },
  { method: 'POST', path: '/api/proposals/:proposalId/decision', tool: null, service: 'proposals.decide' },
  { method: 'POST', path: '/api/analysis/replay', tool: 'replay_analysis', service: 'analysis.replayUnavailable' },
] as const;
export const MCP_OPERATIONS = API_OPERATIONS.filter((op) => op.tool !== null);
/** Platform routes are operator HTTP only; no generic Telegram send/login tool for Hermes. */
export const PLATFORM_OPERATIONS = [
  { method: 'GET', path: '/api/status', service: 'platform.operationsStatus' },
  { method: 'GET', path: '/api/telegram/login', service: 'telegram.loginState' },
  { method: 'POST', path: '/api/telegram/login', service: 'telegram.submitLogin' },
  { method: 'POST', path: '/api/telegram/control-setup', service: 'telegram.configureControlChat' },
  { method: 'POST', path: '/api/telegram/control-setup/:operationKey/reconcile', service: 'telegram.reconcileControlSetup' },
] as const;
export type McpToolName = Exclude<(typeof API_OPERATIONS)[number]['tool'], null>;
export type ErrorCode = 'unauthenticated' | 'forbidden' | 'validation' | 'not_found' | 'conflict' | 'stale_proposal' | 'excluded_chat' | 'ambiguous_mapping' | 'upstream_unavailable' | 'not_configured' | 'internal';
export interface ApiError { error: { code: ErrorCode; message: string; retryable: boolean; requestId: string } }
export class DomainError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly retryable = false) { super(message); this.name = 'DomainError'; }
}
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401, forbidden: 403,
  validation: 400, not_found: 404, conflict: 409, stale_proposal: 409, excluded_chat: 409,
  ambiguous_mapping: 409, upstream_unavailable: 503, not_configured: 503, internal: 500,
};
