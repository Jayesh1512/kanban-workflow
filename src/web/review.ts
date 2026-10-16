import { html } from 'hono/html';
import { z } from 'zod';
import { acceptReview, changeReview, dismissReview, getReview, listReview } from '../agent/index.ts';
import { getSetting } from '../auth/index.ts';
import { listLanes, searchCards } from '../board/index.ts';
import type { Ctx, ReviewChange, ReviewItemView } from '../contracts/index.ts';
import {
  dismissalExplanation,
  dismissalLabel,
  proposalFacts,
  reviewAction,
  reviewExplanation,
  reviewTitle,
} from './proposal.ts';
import { messages } from './render.ts';
import type { Markup, WebApp } from './shared.ts';
import {
  form,
  formId,
  id,
  isNotBuilt,
  optionalId,
  pageHeading,
  parse,
  shell,
  textField,
  time,
  unavailable,
} from './shared.ts';

function changeForms(ctx: Ctx, item: ReviewItemView): Markup {
  const lanes = listLanes(ctx);
  const cards = searchCards(ctx, { limit: Number.MAX_SAFE_INTEGER }).cards;
  const direct = item.proposal.kind === 'is_work' || item.proposal.kind === 'model_failed';
  const labels = {
    new_card: 'Create a deal',
    card: 'Link to an existing deal',
    stage: 'Choose a different stage',
    company: 'Correct company name',
    role: 'Correct contact role',
  };
  const buttons = {
    new_card: 'Create deal and link messages',
    card: 'Link messages to deal',
    stage: 'Apply stage correction',
    company: 'Apply company correction',
    role: 'Apply role correction',
  };
  return html`${item.allowedChanges.map((to) => html`<details class="decision-option" ${direct && item.allowedChanges.length === 1 ? html`open` : ''}><summary>${labels[to]}</summary>${((to === 'new_card' || to === 'stage') && !lanes.length) || (to === 'card' && !cards.length) ? html`<p>${to !== 'card' ? 'No active pipeline destination is available. Set up a lane before applying this correction.' : 'There are no active deals to link. Create a deal instead.'}</p>${to !== 'card' ? html`<a href="/lanes">Set up pipeline rules</a>` : ''}` : html`<form method="post" action="/review/${item.id}/change"><input type="hidden" name="to" value="${to}">${to === 'new_card' ? html`<p>Create a deal and attach this suggestion's supporting messages.</p><label>Lane<select name="laneId" required>${lanes.map((l) => html`<option value="${l.id}" ${item.proposal.kind === 'new_card' && item.proposal.laneId === l.id ? html`selected` : ''}>${l.name}</option>`)}</select></label><label>Title<input name="title" value="${item.proposal.kind === 'new_card' ? item.proposal.title : ''}" required></label><label>Summary<textarea name="summary">${item.proposal.kind === 'new_card' ? item.proposal.summary : ''}</textarea></label><p class="muted">Starts in the selected lane's first stage.</p><input type="hidden" name="stageId" value="">` : to === 'card' ? html`<p>Link the supporting messages to the deal you choose.</p><label>Deal<select name="cardId" required><option value="" selected disabled>Choose a deal</option>${cards.map((card) => html`<option value="${card.id}">${card.title}</option>`)}</select></label>` : to === 'stage' ? html`<label>Lane / stage<select name="stageId" required><option value="" selected disabled>Choose a destination</option>${lanes.map((l) => html`<optgroup label="${l.name}">${l.stages.map((s) => html`<option value="${s.id}">${s.name}</option>`)}</optgroup>`)}</select></label>` : to === 'company' ? html`<label>Company name<input name="company" required></label>` : html`<label>Category<select name="category">${getSetting<string[]>(ctx.db, 'role_categories').map((r) => html`<option>${r}</option>`)}</select></label><label>Responsibilities (deals about)<textarea name="dealsAbout"></textarea></label>`}<button>${buttons[to]}</button></form>`}</details>`)}`;
}
export function reviewDetails(ctx: Ctx, item: ReviewItemView): Markup {
  return html`<nav class="breadcrumb" aria-label="Breadcrumb"><a href="/review">Review suggestions</a><span>${reviewAction(item)}</span></nav>${pageHeading(reviewTitle(ctx, item), reviewExplanation(ctx, item))}<main class="detail-layout review-layout"><div><section><h2>${reviewAction(item)}</h2>${proposalFacts(ctx, item)}<p class="decision-jump"><a href="#your-decision">Choose what happens next</a></p><h3 class="reason-heading">Why this was suggested</h3><p class="prose">${item.proposal.kind === 'model_failed' ? 'AI did not return a usable action. The original diagnostic is available under technical details.' : item.reason}</p><p class="muted">${item.chat?.title ?? 'No chat recorded'} · Updated ${time(item.updatedAt)}</p></section><section><h2>Supporting messages <span class="count">${item.messages.length}</span></h2>${messages(item.messages)}</section><details class="disclosure"><summary>Technical details</summary><p>Model score: ${item.confidence}. This is not a measured probability of correctness.</p><p>Created ${time(item.createdAt)} · Updated ${time(item.updatedAt)}</p><p>${item.kind} · ${item.why} · ${item.reason}</p><pre>${JSON.stringify(item.proposal, null, 2)}</pre></details></div><aside class="detail-sidebar"><section id="your-decision"><h2>Your decision</h2>${item.canAccept ? html`${item.proposal.kind === 'is_work' ? html`<p>Leave these messages without a deal, or choose a deal below.</p>` : ''}<form method="post" action="/review/${item.id}/accept"><button>${item.proposal.kind === 'is_work' ? 'Leave off pipeline' : reviewAction(item)}</button></form>` : item.proposal.kind === 'is_work' ? html`<p>Choose how to track this conversation below. Nothing changes until you decide.</p>` : html`<p class="notice">This proposal cannot be accepted. It has no valid current action. The evidence or destination may have changed. Use an available correction or dismiss it.</p>`}${changeForms(ctx, item)}<form method="post" action="/review/${item.id}/dismiss"><p class="muted">${dismissalExplanation(item)}</p><button class="secondary">${dismissalLabel(item)}</button></form></section></aside></main>`;
}
const changeSchema = z.discriminatedUnion('to', [
  z.strictObject({
    to: z.literal('new_card'),
    laneId: formId,
    title: textField,
    summary: z.string().max(50000),
    stageId: optionalId,
  }),
  z.strictObject({ to: z.literal('card'), cardId: formId }),
  z.strictObject({ to: z.literal('stage'), stageId: formId }),
  z.strictObject({ to: z.literal('company'), company: textField }),
  z.strictObject({ to: z.literal('role'), category: textField, dealsAbout: z.string().max(20000) }),
]);
export function registerReview(app: WebApp): void {
  app.get('/review', (c) => {
    const ctx = c.get('ctx');
    try {
      const items = listReview(ctx);
      return c.html(
        shell(
          'Review',
          html`${pageHeading('Review suggestions', 'Check the proposed change and its messages. You decide what reaches the pipeline.')}<main>${items.length ? html`<ul class="entity-list">${items.map((r) => html`<li><a href="/review/${r.id}">${reviewTitle(ctx, r)}</a><span>${reviewAction(r)} · ${r.chat?.title ?? 'No chat recorded'}</span><p>${reviewExplanation(ctx, r)}</p></li>`)}</ul>` : html`<section class="empty-state"><h2>All suggestions reviewed</h2><p>No open review items. New suggestions from included chats will appear here when they need a decision.</p><a href="/board">View pipeline</a> · <a href="/settings/accounts">Manage included chats</a></section>`}</main>`,
          '/review',
        ),
      );
    } catch (error) {
      if (!isNotBuilt(error, 'listReview')) throw error;
      return c.html(
        shell(
          'Review unavailable',
          html`${pageHeading('Review', 'Human decisions stay in control.')}${unavailable('Review queue')}`,
          '/review',
        ),
        503,
      );
    }
  });
  app.get('/review/:id', (c) => {
    const reviewId = id(c);
    try {
      return c.html(
        shell('Review decision', reviewDetails(c.get('ctx'), getReview(c.get('ctx'), reviewId)), '/review'),
      );
    } catch (error) {
      if (!isNotBuilt(error, 'getReview')) throw error;
      return c.html(shell('Review unavailable', unavailable('Review details'), '/review'), 503);
    }
  });
  app.post('/review/:id/accept', async (c) => {
    // Existing primary12/default1 uses this functioning public settlement path.
    parse(z.strictObject({}), await form(c));
    acceptReview(c.get('ctx'), id(c));
    return c.redirect('/board', 303);
  });
  app.post('/review/:id/change', async (c) => {
    const reviewId = id(c);
    const change: ReviewChange = parse(changeSchema, await form(c));
    try {
      changeReview(c.get('ctx'), reviewId, change);
    } catch (error) {
      if (!isNotBuilt(error, 'changeReview')) throw error;
      return c.html(shell('Review unavailable', unavailable('Changing review decisions'), '/review'), 503);
    }
    return c.redirect('/review', 303);
  });
  app.post('/review/:id/dismiss', async (c) => {
    parse(z.strictObject({}), await form(c));
    const reviewId = id(c);
    try {
      dismissReview(c.get('ctx'), reviewId);
    } catch (error) {
      if (!isNotBuilt(error, 'dismissReview')) throw error;
      return c.html(shell('Review unavailable', unavailable('Dismissing review decisions'), '/review'), 503);
    }
    return c.redirect('/review', 303);
  });
}
