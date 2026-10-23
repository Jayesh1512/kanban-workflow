import type { RecordsService } from '../shared/ports.js';
import type { CardContext } from './card-format.js';

/** Load complete tasks and company contacts independently of the recent-message
 * window. Source validation and inclusion rules stay in the canonical records service. */
export async function loadCardContext(records: RecordsService, ticketId: string): Promise<CardContext> {
  const context = await records.getContext({ ticketId, limit: 100 });
  const facts = [] as CardContext['facts'];
  let cursor: string | undefined;
  do {
    const page = await records.listFacts({ ticketId, limit: 200, ...(cursor ? { cursor } : {}) });
    facts.push(...page.items); cursor = page.nextCursor ?? undefined;
  } while (cursor);
  const contacts = new Map(context.contacts.map(contact => [contact.id, contact]));
  if (context.ticket.companyId) {
    cursor = undefined;
    do {
      const page = await records.listContacts({ companyId: context.ticket.companyId, limit: 200, ...(cursor ? { cursor } : {}) });
      for (const contact of page.items) contacts.set(contact.id, contact);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
  const evidence = new Map(context.evidence.map(item => [item.id, item]));
  const missing = [...new Set(facts.flatMap(fact => [...fact.evidenceIds, ...fact.dates.flatMap(date => date.evidenceIds)]))].filter(id => !evidence.has(id));
  for (let offset = 0; offset < missing.length; offset += 200) {
    for (const item of await records.getEvidence(missing.slice(offset, offset + 200))) evidence.set(item.id, item);
  }
  return { ...context, facts, contacts: [...contacts.values()], evidence: [...evidence.values()] };
}
