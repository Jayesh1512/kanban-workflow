import type { Chat, Ticket } from './domain.js';

/** An unknown company is explicit; a contact prospect never stands in for a company. */
export function currentTicketMapping(chat: Pick<Chat, 'companyId' | 'mappingStatus'>, ticket: Pick<Ticket, 'kind' | 'companyId'>): boolean {
  return ticket.kind === 'contact_prospect'
    ? ticket.companyId === null && chat.companyId === null && ['unresolved', 'ambiguous'].includes(chat.mappingStatus)
    : ticket.companyId !== null && chat.mappingStatus === 'confirmed' && chat.companyId === ticket.companyId;
}
