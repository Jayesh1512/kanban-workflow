import type { BusinessFact, DateFact } from '../shared/domain.js';
import type { RecordsService } from '../shared/ports.js';
import { ticketTitle } from '../shared/ticket-title.js';

export type CardContext = Awaited<ReturnType<RecordsService['getContext']>>;
const singleLine = (value: string) => value.replace(/\s+/gu, ' ').trim();
const clip = (value: string, length: number) => value.length <= length ? value : `${value.slice(0, length - 1).trimEnd()}…`;
// Vikunja's description editor consumes HTML. Every value from Telegram/models
// is text, including apparent markup; only this renderer supplies HTML tags.
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const text = (value: string) => escape(value).replace(/\r?\n/g, '<br>');
const paragraph = (value: string) => `<p>${text(value)}</p>`;
const field = (label: string, value: string) => `<p><strong>${escape(label)}:</strong> ${text(value)}</p>`;
const section = (name: string, body: string) => `<h2>${escape(name)}</h2>${body}`;
const list = (items: string[], empty: string) => items.length ? `<ul>${items.map(item => `<li>${item}</li>`).join('')}</ul>` : paragraph(empty);
const pendingTask = (fact: BusinessFact) => fact.state === 'open' && ['action', 'commitment'].includes(fact.kind);
const actor = (fact: BusinessFact) => `${fact.actor.party === 'antseed' ? 'AntSeed' : fact.actor.party === 'external' ? 'Other party' : 'Owner unconfirmed'}${fact.actor.displayName && fact.actor.displayName !== 'AntSeed' ? ` · ${fact.actor.displayName}` : ''}`;

function instant(value: string | null): string {
  if (!value) return 'Not set';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Unresolved';
  return `${new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)} IST`;
}

export function cardDate(date: DateFact): string {
  const quote = `“${date.originalText}”`;
  if (date.ambiguous || date.precision === 'unresolved') return `${quote} — unresolved; clarification needed (${date.timezone})`;
  if (date.precision === 'date' && date.localDate) return `${date.localDate} · date only (${date.timezone}); source: ${quote}`;
  if (date.precision === 'instant' && date.resolvedAt) {
    try {
      return `${new Intl.DateTimeFormat('en-GB', { timeZone: date.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date.resolvedAt))} (${date.timezone}; ${date.resolvedAt}); source: ${quote}`;
    } catch { /* Invalid source dates stay unresolved instead of breaking a card. */ }
  }
  return `${quote} — unresolved (${date.timezone})`;
}

/** A compact excerpt of an existing task, never a new inferred commitment. */
function actionTitle(value: string, dates: DateFact[] = []): string {
  const clean = singleLine(value);
  if (/\b(?:unclear|ambiguous|not sure|not clear)\b/i.test(clean)) return 'Clarify next step';
  const verbs = 'send|share|review|follow up|schedule|confirm|resolve|fix|test|integrate|check|provide|prepare|introduce|connect|reply|respond|arrange|update|complete|verify|discuss|set up|reach out|deliver|append|submit|draft|pay|sign|contact|wait';
  let imperative = clean.replace(/^(?:AntSeed|we|I)\s+(?:(?:will|should|must|need to|have to)\s+)?/i, '');
  const reported = clean.match(new RegExp(`\\b(?:will|would|need to|needs to|agreed to|promised to)\\s+((?:(?:not|never)\\s+)?(?:${verbs})\\b.*)`, 'i'));
  const verb = imperative.match(new RegExp(`\\b(?:${verbs})\\b`, 'i'));
  if (reported) imperative = reported[1]!;
  else if (verb?.index !== undefined) {
    const prefix = imperative.slice(0, verb.index);
    // Keep explicit restrictions intact when reducing reported speech to a task.
    const negative = prefix.match(/(?:\bnot|\bnever|\bcannot|\bcan't|\bwon't|\bdon't|\bdo not)\s+(?:\w+\s+){0,3}$/i)?.[0] ?? '';
    imperative = negative + imperative.slice(verb.index);
  } else if (/\b(?:said|says|reported|mentioned|asked|requested|agreed|promised)\b/i.test(clean)) return 'Confirm next step';
  imperative = imperative.split(/(?<=[.!?])\s+(?=[A-Z])/u)[0]!.replace(/[.!]$/, '');
  // Relative dates belong in the sourced date section, so an old "tomorrow"
  // cannot look like a new deadline every day the board is opened.
  for (const date of dates) {
    const phrase = singleLine(date.originalText).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (phrase) imperative = imperative.replace(new RegExp(`\\s+(?:(?:on|by|before)\\s+)?${phrase}[.!]?$`, 'iu'), '');
  }
  return clip(imperative ? imperative[0]!.toUpperCase() + imperative.slice(1) : 'Confirm next step', 110);
}

function nextAction(context: CardContext, ours: BusinessFact[]): { title: string; detail: string; dates: DateFact[] } {
  const { ticket, outreach } = context;
  if (ticket.actionsSource === 'manual' && ticket.nextAction?.trim()) return { title: actionTitle(ticket.nextAction), detail: ticket.nextAction, dates: [] };
  if (ours.length) return { title: actionTitle(ours[0]!.text, ours[0]!.dates), detail: ours[0]!.text, dates: ours[0]!.dates };
  if (ticket.lane === 'Completed') return { title: 'Completed', detail: 'No open AntSeed task is recorded. Review completed items below.', dates: [] };
  if (ticket.lane === 'Archived') return { title: 'Archived', detail: 'No open AntSeed task is recorded. Revisit this conversation when needed.', dates: [] };
  if (ticket.lane === 'Blocked') return { title: 'Resolve blocker', detail: ticket.blockers[0] ?? 'Review the blocker and confirm the next step.', dates: [] };
  if (outreach?.waitingForReply) return { title: 'Follow up', detail: 'Follow up on our last message; no later reply is present in the captured conversation. No follow-up deadline is assumed.', dates: [] };
  if (context.facts.some(f => f.state === 'open' && f.kind === 'question' && f.actor.party === 'external')) return { title: 'Review their questions', detail: 'Review the other party’s open questions and confirm which need our response.', dates: [] };
  return { title: 'Confirm next step', detail: 'No open AntSeed task is recorded. Review the conversation and set the next action.', dates: [] };
}

function compactInstant(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Clarify date';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date) + ' IST';
}

function compactDate(date: DateFact): string | null {
  if (date.ambiguous || date.precision === 'unresolved') return 'Clarify date';
  if (date.precision === 'date' && date.localDate) return date.localDate;
  if (date.precision === 'instant' && date.resolvedAt) return compactInstant(date.resolvedAt);
  return null;
}

function titleEta(context: CardContext, dates: DateFact[]): string {
  if (context.ticket.etaAt) return compactInstant(context.ticket.etaAt);
  const sourced = dates.map(compactDate).find((value): value is string => !!value);
  if (sourced) return sourced;
  if (context.ticket.followUpAt) return compactInstant(context.ticket.followUpAt);
  return 'Not set';
}

function titleDescription(context: CardContext): string {
  const businessText = (value: string | null | undefined) => {
    const clean = value?.trim();
    return clean && !/(?:model provider failed|provider_unavailable|no_providers_available|restrictedmodelserror|ai gateway logs?|openai extraction|jev provider|gateway entitlement)/i.test(clean) ? clean : null;
  };
  const summary = businessText(context.ticket.summary) || businessText(context.company?.summary);
  if (summary) return summary;
  const evidence = context.evidence.map(item => businessText(item.excerpt)).find((item): item is string => !!item);
  if (evidence) return evidence;
  if (context.ticket.kind === 'contact_prospect' && !context.company) return 'New contact prospect';
  return `${context.ticket.workstream} relationship in ${context.ticket.lane}`;
}

/** Combine repeated extractions without losing different owners, dates or states. */
function distinctFacts(facts: BusinessFact[]): BusinessFact[] {
  const seen = new Set<string>();
  return facts.filter(fact => {
    const key = JSON.stringify([singleLine(fact.text), fact.kind, fact.state, fact.actor, fact.dates.map(d => [d.kind, d.originalText, d.localDate, d.resolvedAt, d.precision, d.ambiguous, d.timezone])]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function factItem(fact: BusinessFact): string {
  return `${paragraph(fact.text)}${paragraph(`Owner: ${actor(fact)} · ${fact.kind} · ${fact.state}${fact.source === 'manual' ? ' · manually recorded' : ''}`)}${fact.dates.map(date => field(date.kind === 'eta' ? 'ETA' : date.kind === 'follow_up' ? 'Follow-up' : 'Due', cardDate(date))).join('')}`;
}

function sourceLink(url: string | null, label: string): string {
  if (url) {
    try { const parsed = new URL(url); if (['https:', 'http:'].includes(parsed.protocol)) return `<a href="${escape(parsed.href)}" rel="noopener noreferrer">${escape(label)}</a>`; } catch { /* Render invalid links as text. */ }
  }
  return escape(label);
}

/** Pure presentation: does not alter facts, deadlines, approvals or board lanes. */
export function formatCard(context: CardContext): { title: string; description: string } {
  const { ticket, chat, company, contacts, outreach } = context;
  const facts = distinctFacts(context.facts);
  const ours = facts.filter(f => pendingTask(f) && f.actor.party === 'antseed');
  // Stable date ordering puts sourced deadlines first; unresolved dates stay last.
  const due = (fact: BusinessFact) => fact.dates.filter(d => !d.ambiguous).map(d => d.localDate ?? d.resolvedAt ?? '').filter(Boolean).sort()[0] ?? '9999';
  ours.sort((a, b) => due(a).localeCompare(due(b)) || Number(b.source === 'manual') - Number(a.source === 'manual') || a.id.localeCompare(b.id));
  const next = nextAction(context, ours);
  const identity = singleLine(company?.canonicalName || chat.title || contacts[0]?.names[0] || 'Unnamed prospect');
  const title = ticketTitle({ identity, description: titleDescription(context), nextAction: next.title, eta: titleEta(context, next.dates) });
  const contactItems = contacts.map(contact => {
    const roles = contact.roles.filter(role => role.companyId === company?.id).map(role => role.role);
    return paragraph(contact.names.join(' / ') || contact.usernames.map(name => `@${name.replace(/^@/, '')}`).join(' / ') || 'Unnamed contact')
      + (roles.length ? field('Role', [...new Set(roles)].join(', ')) : '')
      + field('Affiliation', contact.affiliation === 'internal' ? 'AntSeed' : contact.affiliation === 'external' ? 'External' : 'Unconfirmed')
      + field('Telegram', contact.usernames.length ? contact.usernames.map(name => `@${name.replace(/^@/, '')}`).join(', ') : contact.telegramUserIds.length ? `User ID ${contact.telegramUserIds.join(', ')}` : 'Not recorded')
      + field('Email', contact.emails.join(', ') || 'Not recorded') + field('Phone', contact.phones.join(', ') || 'Not recorded');
  });
  const deadlines = facts.flatMap(fact => fact.dates.map(date => paragraph(fact.text) + field('Owner / status', `${actor(fact)} · ${fact.state}`) + field(date.kind === 'eta' ? 'ETA' : date.kind === 'follow_up' ? 'Follow-up' : 'Commitment', cardDate(date))));
  const blockers = [...new Set(ticket.blockers)].map(paragraph);
  const blockerFacts = facts.filter(f => f.kind === 'blocker' && f.state === 'open');
  const other = facts.filter(f => f.state === 'open' && f.actor.party === 'external' && ['action', 'commitment'].includes(f.kind));
  const questions = facts.filter(f => f.state === 'open' && (f.kind === 'question' || (pendingTask(f) && f.actor.party === 'unknown')));
  const details = facts.filter(f => f.kind === 'fact' && f.state === 'open');
  const closed = facts.filter(f => f.state !== 'open');
  const description = [
    section('At a glance', field('Company', company?.canonicalName || 'Not identified yet — contact prospect') + field('Conversation', chat.title) + field('Stage', ticket.lane) + field('Workstream', ticket.workstream) + field('Our next action', next.title) + field('Follow-up', instant(ticket.followUpAt)) + field('ETA', instant(ticket.etaAt))),
    section('Next action for AntSeed', paragraph(next.detail)),
    section('Relationship summary', paragraph(ticket.summary || company?.summary || 'No summary recorded yet.')),
    section('Contacts', list(contactItems, 'No verified contact details recorded yet.')),
    section('Tasks for AntSeed', (ticket.actionsSource === 'manual' && ticket.nextAction ? field('Manually set next action', ticket.nextAction) : '') + list(ours.map(factItem), next.detail)),
    section('Waiting on the other party', list(other.map(factItem), outreach?.waitingForReply ? 'Awaiting a reply to our last captured message.' : 'No open external commitments recorded.')),
    section('Deadlines & dates', field('Follow-up reminder', instant(ticket.followUpAt)) + field('Ticket ETA', instant(ticket.etaAt)) + list(deadlines, 'No sourced task deadlines recorded.')),
    section('Blockers', list(blockerFacts.length ? blockerFacts.map(factItem) : blockers, 'None recorded.')),
    section('Open questions & unassigned tasks', list(questions.map(factItem), 'None recorded.')),
    section('Conversation activity', field('Last substantive interaction', instant(ticket.latestSubstantiveAt)) + field('Last outgoing message', instant(outreach?.lastOutgoingAt ?? null)) + field('Last incoming message', instant(outreach?.lastIncomingAt ?? null)) + field('Reply status', outreach?.lastOutgoingAt ? outreach.waitingForReply ? 'Awaiting reply' : 'A reply is present after our last message' : 'No outgoing message in captured context') + paragraph('Activity reflects captured messages; unavailable history is not inferred.')),
    section('Completed & closed items', list(closed.map(factItem), 'No completed or closed items recorded.')),
    section('Additional details', (company ? (company.summary && company.summary !== ticket.summary ? field('Company summary', company.summary) : '') + field('Company aliases', company.aliases.join(', ') || 'None recorded') + field('Domains', company.domains.join(', ') || 'Not recorded') + field('Buyer IDs', company.buyerIds.join(', ') || 'Not recorded') + field('Provider IDs', company.providerIds.join(', ') || 'Not recorded') : '') + list(details.map(factItem), 'No additional facts recorded.')),
    section('Sources & references', list(context.evidence.map(e => `${paragraph(e.excerpt)}<p>${sourceLink(e.sourceUrl, `Telegram message ${e.messageId}`)} · Evidence ${escape(e.id)}</p>`), 'No current message evidence in the captured context.') + field('Chat ID', chat.id) + field('Ticket ID', ticket.id) + paragraph('Stage is the current board lane. Workstream identifies the relationship type. Owners distinguish AntSeed tasks from external commitments; date-only and unresolved dates retain their original precision.')),
  ].join('');
  return { title, description };
}
