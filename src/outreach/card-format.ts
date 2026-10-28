import type { BusinessFact, DateFact } from '../shared/domain.js';
import { SALES_STAGES, type OutreachAction, type OutreachDetail, type OutreachSourceContext, type SalesStage } from '../shared/outreach-domain.js';
import { ticketTitle } from '../shared/ticket-title.js';

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]!));
const UNKNOWN = 'Not established from approved evidence';
const TEMPLATE_MARKER = '[antseed-crm-template:v2]';

const stageGuidance: Record<SalesStage, { meaning: string; exit: string }> = {
  lead: {
    meaning: 'A potential buyer, provider or partner has been identified; outreach may have started, but a qualified two-way evaluation is not established.',
    exit: 'Move to Qualification after confirmed interest and an active conversation about fit, need or evaluation.',
  },
  qualification: {
    meaning: 'AntSeed and the external party are actively evaluating fit, requirements and the buying or partnership process.',
    exit: 'Move to Negotiation when concrete commercial, pricing, contract or approval terms are being agreed.',
  },
  negotiation: {
    meaning: 'Commercial terms, pricing, contract, procurement, security approval or the final scope are under active agreement.',
    exit: 'Move to Deal Won only after an evidenced commercial commitment or completed agreement.',
  },
  won: {
    meaning: 'The commercial relationship is confirmed through an accepted agreement, purchase or other evidenced won outcome.',
    exit: 'Keep current for account follow-through; reopen only through an explicit reviewed decision.',
  },
  archived: {
    meaning: 'The opportunity was explicitly closed, declined, disqualified, duplicated or intentionally removed from the active pipeline.',
    exit: 'Reopen only when new evidence justifies a reviewed active stage.',
  },
};

const uniq = <T>(items: T[]) => [...new Set(items)];
const facts = (sources: OutreachSourceContext[]) => {
  const seen = new Set<string>();
  return sources.flatMap(source => source.facts).filter(fact => !seen.has(fact.id) && seen.add(fact.id));
};
const matching = (items: BusinessFact[], pattern: RegExp) => items.filter(fact => pattern.test(fact.text));
const joined = (items: BusinessFact[]) => items.length ? `<ul>${items.map(fact => `<li>${esc(fact.text)}</li>`).join('')}</ul>` : esc(UNKNOWN);
const dateText = (date: DateFact) => date.precision === 'date'
  ? `${date.localDate ?? 'Date unresolved'} (${date.timezone}; date only)`
  : date.precision === 'instant' ? (date.resolvedAt ?? 'Date unresolved') : 'Date unresolved';
const deadline = (fact: BusinessFact) => fact.dates.length ? fact.dates.map(date => `${esc(date.originalText)} → ${esc(dateText(date))}`).join('<br>') : 'No deadline stated';
const actionDeadline = (action: OutreachAction) => action.precision === 'date'
  ? `${action.localDate ?? 'Date unresolved'} (${action.timezone}; date only)`
  : action.precision === 'instant' ? (action.instant ?? 'Date unresolved') : 'No deadline stated';

const titleEta = (action: OutreachAction | undefined) => action?.precision === 'date'
  ? action.localDate ?? 'Clarify date'
  : action?.precision === 'instant' ? action.instant ?? 'Clarify date' : 'Not set';

const titleDescription = (snapshot: OutreachDetail, stage: SalesStage) => {
  const active = snapshot.activeSources;
  const businessText = (value: string | null | undefined) => {
    const clean = value?.trim();
    return clean && !/(?:model provider failed|provider_unavailable|no_providers_available|restrictedmodelserror|ai gateway logs?|openai extraction|jev provider|gateway entitlement)/i.test(clean) ? clean : null;
  };
  return active.map(source => businessText(source.reportSummary)).find((value): value is string => !!value)
    ?? active.flatMap(source => source.facts).filter(fact => fact.kind === 'fact').map(fact => businessText(fact.text)).find((value): value is string => !!value)
    ?? active.flatMap(source => source.evidence).map(item => businessText(item.excerpt)).find((value): value is string => !!value)
    ?? `${SALES_STAGES.find(item => item.id === stage)?.label ?? 'Sales'} opportunity`;
};

export interface SalesCardInput {
  snapshot: OutreachDetail;
  stage: SalesStage;
  action: string;
  marker: string;
  generation: string;
}

/** Render only the immutable, approved snapshot supplied to publication. */
export function salesCard({ snapshot, stage, action, marker, generation }: SalesCardInput): { title: string; description: string } {
  const sources = [...snapshot.activeSources, ...snapshot.pendingSources];
  const allFacts = facts(sources);
  const allContacts = sources.flatMap(source => source.contacts).filter((contact, index, items) => items.findIndex(other => other.id === contact.id) === index);
  const stageInfo = stageGuidance[stage];
  const commercial = matching(allFacts, /\b(budget|price|pricing|fee|fees|rate|quote|commercial|payment|discount|revenue|contract|agreement|procurement|settlement|payout|commission|kyc)\b/i);
  const needs = matching(allFacts, /\b(need|needs|require|requires|requirement|problem|pain|use case|looking for|want|wants|cost|bill|capacity|traffic|inference|compute|routing|latency)\b/i);
  const technical = matching(allFacts, /\b(api|sdk|integration|endpoint|model|gpu|pilot|test|testing|security|data|latency|throughput|capacity|engineering|implementation|deployment)\b/i);
  const risks = allFacts.filter(fact => fact.kind === 'blocker' || fact.kind === 'question' || /\b(blocked|pending|waiting|issue|error|fail|cannot|can't|concern|risk|unavailable|no reply|authentication|rate limit)\b/i.test(fact.text));
  const timeline = allFacts.filter(fact => fact.dates.length > 0);
  const closeDate = timeline.find(fact => /\b(close|closing|sign|signed|contract|agreement|purchase|go live|launch)\b/i.test(fact.text));
  const decisionContacts = allContacts.filter(contact => contact.roles.some(role => /\b(founder|owner|ceo|cto|chief|vp|vice president|director|head|procurement|finance|decision)\b/i.test(role)));
  const contacts = allContacts.length ? `<ul>${allContacts.map(contact => `<li><strong>${esc(contact.names.join(', ') || contact.usernames.join(', ') || 'Unnamed contact')}</strong> — ${esc(contact.roles.join(', ') || 'Role unknown')} (${esc(contact.affiliation)})${contact.emails?.length ? `<br>Email: ${esc(contact.emails.join(', '))}` : ''}${contact.phones?.length ? `<br>Phone: ${esc(contact.phones.join(', '))}` : ''}</li>`).join('')}</ul>` : esc(UNKNOWN);
  const sourceLabels = uniq(sources.map(source => `${source.title} (${source.kind === 'telegram' ? 'Telegram' : 'email report'})`));
  const openActions = (snapshot.actions ?? []).filter(item => item.state === 'open');
  const titleAction = openActions.find(item => item.actor === 'antseed' && item.text.trim() === action.trim())
    ?? openActions.find(item => item.actor === 'antseed');
  const actionRows = openActions.length ? `<ul>${openActions.map(item => `<li><strong>${esc(item.actor === 'antseed' ? 'AntSeed' : item.actor)}:</strong> ${esc(item.text)}<br><strong>Deadline:</strong> ${esc(actionDeadline(item))}</li>`).join('')}</ul>` : `<p>${esc(action)} — owner: AntSeed; deadline: not established</p>`;
  const evidence = sources.map(source => `<h3>${esc(source.title)} · ${esc(source.kind === 'telegram' ? 'Telegram' : 'email report')}</h3>${source.reportSummary ? `<p>${esc(source.reportSummary)}</p>` : ''}${source.evidence.length ? source.evidence.map(item => `<blockquote>${esc(item.excerpt)}${item.sourceUrl ? `<br><a href="${esc(item.sourceUrl)}">Open source</a>` : ''}</blockquote>`).join('') : `<p>${esc(UNKNOWN)}</p>`}`).join('');

  const description = [
    '<h2>Opportunity summary</h2>',
    `<p><strong>Account / person:</strong> ${esc(snapshot.relationship.displayName)}<br><strong>Relationship type:</strong> ${esc(snapshot.relationship.kind === 'company' ? 'Company' : 'Contact prospect')}<br><strong>Workstream:</strong> ${esc(snapshot.relationship.workstream ?? 'Not classified')}<br><strong>Lead source:</strong> ${esc(sourceLabels.join('; ') || UNKNOWN)}<br><strong>Last sourced activity:</strong> ${esc(snapshot.relationship.latestSourceAt ?? UNKNOWN)}<br><strong>Source freshness:</strong> ${esc(snapshot.relationship.sourceState)}</p>`,
    '<h2>Pipeline stage</h2>',
    `<p><strong>Accepted stage:</strong> ${esc(SALES_STAGES.find(item => item.id === stage)?.label)}<br><strong>What this means:</strong> ${esc(stageInfo.meaning)}<br><strong>Exit criterion:</strong> ${esc(stageInfo.exit)}<br><strong>Probability / forecast category:</strong> ${esc(UNKNOWN)} — never inferred only from stage.</p>`,
    '<h2>Next step</h2>',
    `<p><strong>Next AntSeed action:</strong> ${esc(action)}<br><strong>Opportunity owner:</strong> AntSeed</p>${actionRows}`,
    '<h2>Qualification (BANT)</h2>',
    `<h3>Budget — money approved or available</h3>${commercial.length ? joined(commercial) : `<p>${esc(UNKNOWN)}</p>`}`,
    `<h3>Authority — person or committee able to approve</h3><p>${decisionContacts.length ? esc(decisionContacts.map(contact => `${contact.names[0] ?? contact.usernames[0] ?? 'Unnamed'} (${contact.roles.join(', ')})`).join('; ')) : esc(UNKNOWN)}</p>`,
    `<h3>Need — business problem, use case or desired outcome</h3>${needs.length ? joined(needs) : `<p>${esc(UNKNOWN)}</p>`}`,
    `<h3>Timeline — target decision, pilot or implementation timing</h3>${timeline.length ? `<ul>${timeline.map(fact => `<li>${esc(fact.text)}<br>${deadline(fact)}</li>`).join('')}</ul>` : `<p>${esc(UNKNOWN)}</p>`}`,
    '<h2>Commercial terms</h2>',
    `<p><strong>Estimated deal value:</strong> ${esc(UNKNOWN)}<br><strong>Currency:</strong> ${esc(UNKNOWN)}<br><strong>Expected close date:</strong> ${closeDate ? deadline(closeDate) : esc(UNKNOWN)}<br><strong>Decision / purchase process:</strong> ${esc(UNKNOWN)}<br><strong>Forecast probability:</strong> ${esc(UNKNOWN)}</p>`,
    '<h3>Pricing, payment, procurement and contract evidence</h3>', commercial.length ? joined(commercial) : `<p>${esc(UNKNOWN)}</p>`,
    '<h2>Stakeholders and contacts</h2>', contacts,
    '<h2>Customer need and proposed solution</h2>',
    '<h3>Business need</h3>', needs.length ? joined(needs) : `<p>${esc(UNKNOWN)}</p>`,
    '<h3>Technical / delivery scope</h3>', technical.length ? joined(technical) : `<p>${esc(UNKNOWN)}</p>`,
    `<p><strong>Proposed AntSeed solution:</strong> ${esc(UNKNOWN)}<br><strong>Success criteria:</strong> ${esc(UNKNOWN)}<br><strong>Competition / alternatives:</strong> ${esc(UNKNOWN)}</p>`,
    '<h2>Risks, blockers and open questions</h2>', joined(risks),
    '<h2>Approved conversation evidence</h2>', evidence || `<p>${esc(UNKNOWN)}</p>`,
    `<h2>Record controls</h2><p>Only approved source context is shown. Missing fields are deliberately marked as unknown; they are not inferred from silence. Sales stages do not rename work-board lanes. Email-report claims are attributed summaries, not authenticated original emails.</p><p>${esc(TEMPLATE_MARKER)}<br>${esc(marker)}<br>${esc(generation)}</p>`,
  ].join('');
  return { title: ticketTitle({ identity: snapshot.relationship.displayName, description: titleDescription(snapshot, stage), nextAction: action, eta: titleEta(titleAction) }), description };
}

export function reviewCard(displayName: string, relationshipId: string, generation: string, sourceCount: number): { title: string; description: string } {
  const title = ticketTitle({ identity: displayName, description: 'Initial sales stage awaiting review', nextAction: 'Review initial sales stage', eta: 'Not set' });
  const unknown = esc(UNKNOWN);
  const description = [
    `<h2>Opportunity summary</h2><p><strong>Account / person:</strong> ${esc(displayName)}<br><strong>Relationship status:</strong> Awaiting initial source and stage review<br><strong>Linked source conversations:</strong> ${sourceCount}</p>`,
    '<h2>Pipeline stage</h2><p><strong>Accepted sales stage:</strong> Not approved<br><strong>Displayed intake lane:</strong> Lead / Prospect<br><strong>Exit criterion:</strong> Approve the source enrollment and an evidence-backed initial sales stage.</p>',
    '<h2>Next step</h2><p><strong>Next AntSeed action:</strong> Review initial placement and approved source enrollment<br><strong>Opportunity owner:</strong> AntSeed<br><strong>Deadline:</strong> Not established</p>',
    `<h2>Qualification (BANT)</h2><p><strong>Budget:</strong> ${unknown}<br><strong>Authority:</strong> ${unknown}<br><strong>Need:</strong> ${unknown}<br><strong>Timeline:</strong> ${unknown}</p>`,
    `<h2>Commercial terms</h2><p><strong>Estimated deal value:</strong> ${unknown}<br><strong>Currency:</strong> ${unknown}<br><strong>Pricing / payment / contract terms:</strong> ${unknown}<br><strong>Expected close date:</strong> ${unknown}<br><strong>Decision / purchase process:</strong> ${unknown}<br><strong>Forecast probability:</strong> ${unknown}</p>`,
    `<h2>Stakeholders and contacts</h2><p>${unknown}</p><h2>Customer need and proposed solution</h2><p>${unknown}</p><h2>Risks, blockers and open questions</h2><p>Initial source enrollment and stage are awaiting review.</p>`,
    `<h2>Approved conversation evidence</h2><p>Conversation claims are withheld until their source enrollment is approved.</p>`,
    `<h2>Record controls</h2><p>This relationship is visible for intake, but no commercial stage or source enrollment has been approved. Review it in the CRM before publishing conversation claims.</p><p>${esc(TEMPLATE_MARKER)}<br>[antseed-relationship:${esc(relationshipId)}]<br>${esc(generation)}</p>`,
  ].join('');
  return { title, description };
}

/** Remove stale business claims while retaining a useful, consistently structured card. */
export function redactionCard(displayName: string, acceptedStage: SalesStage | null, marker: string, generation: string): { title: string; description: string } {
  const unknown = esc(UNKNOWN);
  const title = ticketTitle({ identity: displayName, description: 'Approved source context changed', nextAction: 'Review changed sources', eta: 'Not set' });
  const description = [
    '<h2>Opportunity summary</h2>',
    `<p><strong>Account / person:</strong> ${esc(displayName)}<br><strong>Source status:</strong> Changed — previously published conversation claims were removed</p>`,
    `<h2>Pipeline stage</h2><p><strong>Accepted sales stage:</strong> ${esc(SALES_STAGES.find(item => item.id === acceptedStage)?.label ?? 'Not approved')}<br><strong>Stage effect:</strong> Unchanged; current source review is required before new commercial claims are published.</p>`,
    '<h2>Next step</h2><p><strong>Next AntSeed action:</strong> Review the current approved sources and publish a fresh commercial assessment<br><strong>Opportunity owner:</strong> AntSeed<br><strong>Deadline:</strong> Not established</p>',
    `<h2>Qualification (BANT)</h2><p><strong>Budget:</strong> ${unknown}<br><strong>Authority:</strong> ${unknown}<br><strong>Need:</strong> ${unknown}<br><strong>Timeline:</strong> ${unknown}</p>`,
    `<h2>Commercial terms</h2><p><strong>Estimated deal value:</strong> ${unknown}<br><strong>Currency:</strong> ${unknown}<br><strong>Pricing / payment / contract terms:</strong> ${unknown}<br><strong>Expected close date:</strong> ${unknown}<br><strong>Decision / purchase process:</strong> ${unknown}</p>`,
    `<h2>Stakeholders and contacts</h2><p>${unknown}</p><h2>Customer need and proposed solution</h2><p>${unknown}</p><h2>Risks, blockers and open questions</h2><p>Source context changed; a fresh evidence review is required.</p><h2>Approved conversation evidence</h2><p>Stale conversation claims were removed until the current source set is reviewed.</p>`,
    `<h2>Record controls</h2><p>The accepted sales stage has not changed. Stale contacts and conversation claims are deliberately withheld until the current source set is reviewed.</p><p>${esc(TEMPLATE_MARKER)}<br>${esc(marker)}<br>${esc(generation)}</p>`,
  ].join('');
  return { title, description };
}
