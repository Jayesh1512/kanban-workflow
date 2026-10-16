import { html } from 'hono/html';
import { getSetting } from '../auth/index.ts';
import { getCard, listLanes } from '../board/index.ts';
import type { Ctx, ReviewItemView } from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';
import { getCompany, getContact } from '../graph/index.ts';
import type { Markup } from './shared.ts';

// Resolve labels through the owning public views. Missing targets remain readable;
// validity and permission to apply are still exclusively the review owner's decision.
function available<T>(read: () => T): T | null {
  try {
    return read();
  } catch (error) {
    if (error instanceof AppError && (error.code === 'not_found' || error.code === 'forbidden')) return null;
    throw error;
  }
}
function location(ctx: Ctx, stageId: number): string {
  for (const lane of listLanes(ctx, { includeArchived: true })) {
    const stage = lane.stages.find((s) => s.id === stageId);
    if (stage) return `${lane.name} / ${stage.name}${lane.archived ? ' (archived)' : ''}`;
  }
  return 'Stage no longer available';
}
export function reviewTitle(ctx: Ctx, item: ReviewItemView): string {
  const p = item.proposal;
  if (p.kind === 'new_card') return p.title || 'Untitled deal suggestion';
  if (p.kind === 'attach' || p.kind === 'move')
    return available(() => getCard(ctx, p.cardId))?.title ?? 'Deal no longer available';
  if (p.kind === 'contact_company' || p.kind === 'contact_role')
    return available(() => getContact(ctx, p.contactId))?.name ?? 'Contact no longer available';
  if (p.kind === 'name_company') return p.name;
  return (
    item.chat?.title ??
    (p.kind === 'is_work' ? 'Does this conversation belong on the pipeline?' : 'Suggestion needs your help')
  );
}
export function reviewAction(item: ReviewItemView): string {
  switch (item.proposal.kind) {
    case 'new_card':
      return 'Create deal';
    case 'attach':
      return 'Link messages to deal';
    case 'move':
      return 'Move deal';
    case 'contact_company':
      return 'Link contact to company';
    case 'contact_role':
      return 'Update contact role';
    case 'name_company':
      return 'Confirm company';
    case 'is_work':
      return 'Choose a deal for this conversation';
    case 'model_failed':
      return 'Decide how to use these messages';
    default:
      return 'Review suggestion';
  }
}
export function dismissalLabel(item: ReviewItemView): string {
  return item.proposal.kind === 'name_company' && item.why === 'similar_name'
    ? 'Keep companies separate'
    : 'Dismiss without changes';
}
export function dismissalExplanation(item: ReviewItemView): string {
  if (item.proposal.kind === 'name_company' && item.why === 'similar_name')
    return 'This records that the names are different companies. Held contact links are applied to a separate company with the proposed name; company references stay pending.';
  if (['new_card', 'attach', 'is_work'].includes(item.proposal.kind))
    return 'Dismiss without creating a deal or linking these messages. The messages stay stored and are settled without a deal.';
  return 'Dismiss closes this suggestion without applying its proposed changes.';
}
export function reviewExplanation(ctx: Ctx, item: ReviewItemView): string {
  if (item.why === 'cross_lane') return 'Moving between lanes always needs your approval.';
  if (item.why === 'human_override') return 'This would change an earlier human decision. Check it before applying.';
  if (item.why === 'cross_chat') return 'Messages from another chat need your review before linking.';
  if (item.why === 'similar_name') return 'A similar company name needs your confirmation.';
  if (item.why === 'model_failed')
    return 'AI could not produce an applicable suggestion. You can choose a correction or dismiss it.';
  if (getSetting<number>(ctx.db, 'review_threshold') >= 1)
    return 'Your team reviews every suggestion before it is applied.';
  return 'This suggestion did not meet the automatic action threshold. Check the evidence before applying it.';
}
export function proposalFacts(ctx: Ctx, item: ReviewItemView): Markup {
  const p = item.proposal;
  const field = (label: string, value: string | Markup) =>
    html`<div><dt>${label}</dt><dd class="prose">${value}</dd></div>`;
  if (p.kind === 'new_card') {
    const lane = listLanes(ctx, { includeArchived: true }).find((l) => l.id === p.laneId);
    const stage = p.move
      ? location(ctx, p.move.toStageId)
      : lane
        ? `${lane.name} / ${lane.stages[0]?.name ?? 'No first stage'}`
        : 'Lane no longer available';
    return html`<dl class="proposal-facts">${field('Proposed title', p.title)}${field('Summary', p.summary || 'No summary proposed.')}${field('Create in', stage)}${field('Company', p.companyId === null ? 'Unknown' : (available(() => getCompany(ctx, p.companyId as number))?.name ?? 'Company no longer available'))}${p.move ? field('Stage entry evidence', p.move.criterion) : ''}</dl><p>${item.messages.length} supporting messages will be linked to this deal.</p>`;
  }
  if (p.kind === 'attach' || p.kind === 'move') {
    const card = available(() => getCard(ctx, p.cardId));
    return html`<dl class="proposal-facts">${field('Deal', card ? html`<a href="/cards/${card.id}">${card.title}</a>` : 'Deal no longer available')}${field('Current location', card ? location(ctx, card.stageId) : 'Unavailable')}${field('Current summary', card?.summary || 'No summary recorded.')}${field('Company', card?.company?.name ?? 'Unknown')}${field('Contacts', card?.contacts.map((contact) => contact.name).join(', ') || 'Unknown')}${p.kind === 'move' ? html`${field('Move to', location(ctx, p.toStageId))}${field('Stage entry evidence', p.criterion)}` : html`${field('Messages to link', String(item.messages.length))}${p.summary !== null ? html`${field('Proposed summary', p.summary || 'Empty summary')}<div><dt>Text protection</dt><dd>Human-written deal text is preserved. This summary applies only if the existing text was generated.</dd></div>` : field('Summary', 'Keep the current deal summary.')}`}</dl>`;
  }
  if (p.kind === 'contact_company' || p.kind === 'contact_role') {
    const company = p.kind === 'contact_company' ? p.company : null;
    const companyName = company
      ? 'name' in company
        ? company.name
        : (available(() => getCompany(ctx, company.id))?.name ?? 'Company no longer available')
      : '';
    const contact = available(() => getContact(ctx, p.contactId));
    return html`<dl class="proposal-facts">${field('Contact', contact ? html`<a href="/contacts/${contact.id}">${contact.name}</a>` : 'Contact no longer available')}${p.kind === 'contact_company' ? html`${field('Current companies', contact?.companies.map((co) => co.name).join(', ') || 'Unknown')}${field('Link to company', companyName)}` : html`${field('Current role', contact?.roleCategory ?? 'Unknown')}${field('Proposed role', p.category)}${field('Responsibilities', p.dealsAbout || 'No responsibilities proposed.')}`}</dl>`;
  }
  if (p.kind === 'name_company') {
    const company = available(() => getCompany(ctx, p.companyId));
    return html`<dl class="proposal-facts">${field('Name to confirm', p.name)}${field('Similar company', company?.name ?? 'Company no longer available')}</dl><p>Confirmation saves this name as an alias of the similar company and applies the held contact links and company references. Choose a different company name below if they are separate.</p><ul>${p.held.map((use) => html`<li>${use.use === 'contact_company' ? `Company link for ${available(() => getContact(ctx, use.contactId))?.name ?? 'an unavailable contact'}` : 'Company reference from a supporting message'}</li>`)}</ul>`;
  }
  if (p.kind === 'is_work')
    return html`<p>Decide whether these messages describe a deal worth tracking. Create a deal, link them to an existing deal, or dismiss the suggestion to leave the pipeline unchanged.</p>`;
  return html`<p>No applicable change is ready for approval. Read the supporting messages, then use an available correction or dismiss this suggestion.</p>`;
}
