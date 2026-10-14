import { html } from 'hono/html';
import { z } from 'zod';
import { acceptReview, changeReview, dismissReview, getReview, listReview } from '../agent/index.ts';
import { getSetting } from '../auth/index.ts';
import { listLanes, searchCards } from '../board/index.ts';
import type { Ctx, ReviewChange, ReviewItemView } from '../contracts/index.ts';
import { messages } from './render.ts';
import type { Markup, WebApp } from './shared.ts';
import {
  empty,
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
  return html`${item.allowedChanges.map((to) => html`<details><summary>Change to ${to === 'card' ? 'an existing card' : to === 'new_card' ? 'a new card' : to}</summary><form method="post" action="/review/${item.id}/change"><input type="hidden" name="to" value="${to}">${to === 'new_card' ? html`<label>Lane<select name="laneId">${lanes.map((l) => html`<option value="${l.id}">${l.name}</option>`)}</select></label><label>Title<input name="title" required></label><label>Summary<textarea name="summary"></textarea></label><input type="hidden" name="stageId" value="">` : to === 'card' ? html`<label>Card<select name="cardId">${searchCards(ctx, { limit: Number.MAX_SAFE_INTEGER }).cards.map((card) => html`<option value="${card.id}">${card.title}</option>`)}</select></label>` : to === 'stage' ? html`<label>Lane / stage<select name="stageId">${lanes.map((l) => html`<optgroup label="${l.name}">${l.stages.map((s) => html`<option value="${s.id}">${s.name}</option>`)}</optgroup>`)}</select></label>` : to === 'company' ? html`<label>Company name<input name="company" required></label>` : html`<label>Category<select name="category">${getSetting<string[]>(ctx.db, 'role_categories').map((r) => html`<option>${r}</option>`)}</select></label><label>Deals about<textarea name="dealsAbout"></textarea></label>`}<button>Change and apply</button></form></details>`)}`;
}
export function reviewDetails(ctx: Ctx, item: ReviewItemView): Markup {
  return html`${pageHeading(item.describe, `${item.kind} · ${item.why}`)}<main class="detail-layout"><div><section><h2>Proposed action</h2><p class="prose">${item.reason}</p><p>Confidence: ${item.confidence}. ${item.chat?.title ?? 'No chat recorded'}.</p><p class="muted">Created ${time(item.createdAt)} · Updated ${time(item.updatedAt)}</p><details><summary>Full proposal</summary><pre>${JSON.stringify(item.proposal, null, 2)}</pre></details></section><section><h2>Supporting messages</h2>${messages(item.messages)}</section></div><aside class="detail-sidebar"><section><h2>Your decision</h2>${item.canAccept ? html`<form method="post" action="/review/${item.id}/accept"><button>Accept proposed action</button></form>` : html`<p class="notice">This proposal cannot be accepted. It has no valid current action. You can use an allowed correction or dismiss it.</p>`}${changeForms(ctx, item)}<form method="post" action="/review/${item.id}/dismiss"><button class="secondary">Dismiss without changes</button></form></section></aside></main>`;
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
          html`${pageHeading('Review', 'Inspect the evidence, then accept, change or dismiss a proposed action.')}<main>${items.length ? html`<ul class="entity-list">${items.map((r) => html`<li><a href="/review/${r.id}">${r.describe}</a><span>${r.kind} · ${r.why} · Confidence ${r.confidence}</span></li>`)}</ul>` : empty('No open review items.')}</main>`,
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
