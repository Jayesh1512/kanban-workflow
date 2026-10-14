import { html } from 'hono/html';
import { z } from 'zod';
import { listReview } from '../agent/index.ts';
import { getSetting } from '../auth/index.ts';
import {
  archiveCard,
  archiveLane,
  attachMessage,
  createCard,
  createLane,
  getBoard,
  getCard,
  listLanes,
  moveCard,
  searchCards,
  unarchiveCard,
  updateCard,
  updateLane,
} from '../board/index.ts';
import { AppError } from '../contracts/index.ts';
import { searchCompanies } from '../graph/index.ts';
import { boardVersion } from '../log/index.ts';
import { boardLanes, cardMetadata, logEntries, messages, references } from './render.ts';
import type { WebApp, WebContext, WebDeps } from './shared.ts';
import {
  empty,
  form,
  formId,
  hidden,
  id,
  isNotBuilt,
  optionalId,
  pageHeading,
  parse,
  shell,
  textField,
} from './shared.ts';
import { providerStatus } from './status.ts';

const stagesSchema = z
  .array(z.strictObject({ id: formId.optional(), name: textField, criteria: z.string().max(20000) }))
  .min(2)
  .max(100);
function laneForm(lane?: ReturnType<typeof listLanes>[number]) {
  const stages = lane?.stages ?? [
    { name: '', criteria: '' },
    { name: '', criteria: '' },
  ];
  return html`<form method="post" action="/lanes${lane ? `/${lane.id}` : ''}" class="stack-form" data-lane-form><label>Lane name<input name="name" value="${lane?.name ?? ''}" required></label><label>SOP<textarea name="sop" rows="4" required>${lane?.sop ?? ''}</textarea></label><fieldset><legend>Stages in order</legend><p class="muted">At least two stages. Define the entry criteria for each stage after the first. Removing a stage that holds cards is refused.</p><div data-stage-rows>${stages.map((s, index) => html`<div class="stage-editor">${hidden(`stageId${index}`, 'id' in s ? s.id : '')}<label>Stage ${index + 1} name<input name="stageName${index}" value="${s.name}" required></label><label>Entry criteria<textarea name="stageCriteria${index}" rows="2" ${index ? html`required` : ''}>${s.criteria}</textarea></label><button type="button" class="quiet" data-remove-stage>Remove stage</button></div>`)}</div><button type="button" class="secondary" data-add-stage>Add stage</button></fieldset><button>${lane ? 'Save lane' : 'Create lane'}</button></form>`;
}
function parseLane(body: Record<string, string>) {
  const stageKeys = Object.keys(body)
    .filter((k) => /^stageName\d+$/.test(k))
    .sort((a, b) => Number(a.slice(9)) - Number(b.slice(9)));
  const allowed = new Set([
    'name',
    'sop',
    ...stageKeys.flatMap((k) => {
      const n = k.slice(9);
      return [k, `stageId${n}`, `stageCriteria${n}`];
    }),
  ]);
  if (Object.keys(body).some((k) => !allowed.has(k))) throw new AppError('invalid', 'Invalid lane fields.');
  const stages = stageKeys.map((key) => {
    const n = key.slice(9);
    return {
      ...(body[`stageId${n}`] ? { id: body[`stageId${n}`] } : {}),
      name: body[key],
      criteria: body[`stageCriteria${n}`],
    };
  });
  const parsed = parse(
    z.strictObject({ name: textField, sop: z.string().trim().min(1).max(50000), stages: stagesSchema }),
    { name: body.name, sop: body.sop, stages },
    'A lane needs a name, an SOP and at least two named stages.',
  );
  if (parsed.stages.slice(1).some((s) => !s.criteria.trim()))
    throw new AppError('invalid', 'Every stage after the first needs entry criteria.');
  return parsed;
}

export function registerBoard(app: WebApp, deps: WebDeps): void {
  const boardPage = (c: WebContext) => {
    const ctx = c.get('ctx');
    const board = getBoard(ctx);
    const accounts = deps.host
      .listAccounts(ctx)
      .filter((a) => a.teammateId === (ctx.actor.kind === 'teammate' ? ctx.actor.id : -1) && a.state !== 'removed');
    const counts = accounts.length ? deps.host.chatCounts(ctx) : null;
    let reviewAvailable = true;
    try {
      listReview(ctx, { limit: 1 });
    } catch (error) {
      if (!isNotBuilt(error, 'listReview')) throw error;
      reviewAvailable = false;
    }
    const threshold = getSetting<number>(deps.db, 'review_threshold');
    const pipeline = deps.pipeline.status();
    const lanes = listLanes(ctx);
    return c.html(
      shell(
        'Board',
        html`${pageHeading('Team board', 'Work across the team. Open a card to inspect its evidence.', html`<a class="button" href="#create-card">Create card</a>`)}
      <header id="status" class="status-strip" data-automatic-off="${Number(threshold >= 1)}" data-pipeline-state="${pipeline.state}" data-pipeline-reason="${pipeline.reason ?? ''}" data-open-review="${board.openReviewCount}" data-movement-state="${pipeline.movement.state}" data-movement-reason="${pipeline.movement.reason ?? ''}"><div><strong>${threshold >= 1 ? 'Automatic actions are off.' : 'Automatic actions above the review threshold are enabled.'}</strong><p>${threshold >= 1 ? 'Decisions wait for human review.' : 'Every cross-lane move still needs human review.'} Threshold: ${threshold}. <a href="/review">${board.openReviewCount} stored review items${reviewAvailable ? '' : ' · queue unavailable'}</a></p></div>${providerStatus(deps)}</header>
      ${counts === null ? '' : html`<aside id="my-chats" class="chat-summary" data-connected="${Number(counts.connected)}" data-undecided="${counts.undecidedRecent ?? ''}" data-out-of-date="${counts.agreementOutOfDate}"><strong>Your chats</strong><span>${counts.undecidedRecent === null ? 'Undecided chat count is unknown.' : `${counts.undecidedRecent} recent undecided chats.`} ${counts.agreementOutOfDate} confirmations out of date.</span>${accounts.map((a) => html`<a href="/settings/accounts/${a.id}/chats">${a.label}: choose chats</a>`)}</aside>`}
      <main id="board" data-version="${board.version}">${boardLanes(board)}</main>
      <section id="create-card" class="form-section"><h2>Create a card</h2>${lanes.length ? html`<form method="post" action="/cards" class="stack-form"><label>Title<input name="title" required></label><label>Lane<select name="laneId" required>${lanes.map((l) => html`<option value="${l.id}">${l.name}</option>`)}</select></label><p class="muted">Starts in the selected lane's first stage. You can move it from the detail page.</p><label>Summary<textarea name="summary" rows="3"></textarea></label><label>Company<select name="companyId"><option value="">Unknown</option>${searchCompanies(ctx, { limit: Number.MAX_SAFE_INTEGER }).map((co) => html`<option value="${co.id}">${co.name}</option>`)}</select></label><button>Create card</button></form>` : html`<p><a href="/lanes">Create a lane first</a> with its SOP and stages.</p>`}</section>`,
      ),
    );
  };
  app.get('/', boardPage);
  app.get('/board', boardPage);
  app.get('/board/fragment', (c) => c.html(boardLanes(getBoard(c.get('ctx')))));
  app.get('/board/version', (c) => c.json({ version: boardVersion(c.get('ctx').db) }));
  app.get('/cards/:id', (c) => {
    const ctx = c.get('ctx');
    const card = getCard(ctx, id(c));
    const lanes = listLanes(ctx);
    const lane = listLanes(ctx, { includeArchived: true }).find((l) => l.id === card.laneId);
    return c.html(
      shell(
        card.title,
        html`<nav class="breadcrumb" aria-label="Breadcrumb"><a href="/board">Board</a><span>${lane?.name ?? 'Unknown lane'} / ${lane?.stages.find((s) => s.id === card.stageId)?.name ?? 'Unknown stage'}</span></nav>${pageHeading(card.title, card.archived ? 'Archived card' : 'Card details')}
      <main class="detail-layout"><div class="evidence-column"><section><h2>Summary</h2><p class="prose">${card.summary || 'No summary recorded.'}</p>${card.hasGap ? html`<p class="notice">This card has a history gap. Its linked messages may be incomplete.</p>` : ''}</section><section><h2>Linked messages <span class="count">${card.messages.length}</span></h2><p class="muted">In time order, from the stored conversations.</p>${messages(card.messages, searchCards(ctx, { limit: Number.MAX_SAFE_INTEGER }).cards)}</section><section><h2>Known-company references</h2>${references(card.references)}</section><section><h2>History & human corrections</h2>${logEntries(card.history)}</section></div>
      <aside class="detail-sidebar"><section><h2>Context</h2>${cardMetadata(card)}</section><section><h2>Correct card</h2><form method="post" action="/cards/${card.id}"><label>Title<input name="title" value="${card.title}" required></label><label>Summary<textarea name="summary" rows="4">${card.summary}</textarea></label><label>Company<select name="companyId"><option value="">Unknown</option>${searchCompanies(ctx, { limit: Number.MAX_SAFE_INTEGER }).map((co) => html`<option value="${co.id}" ${co.id === card.company?.id ? html`selected` : ''}>${co.name}</option>`)}</select></label><label>Correction reason<input name="reason" required></label><button>Save correction</button></form></section>
      ${!card.archived ? html`<section><h2>Move card</h2><form method="post" action="/cards/${card.id}/move"><label>Lane / stage<select name="stageId">${lanes.map((l) => html`<optgroup label="${l.name}">${l.stages.map((s) => html`<option value="${s.id}" ${s.id === card.stageId ? html`selected` : ''}>${s.name}</option>`)}</optgroup>`)}</select></label><label>Reason<input name="reason" required></label><button>Move card</button></form></section>` : ''}<section><form method="post" action="/cards/${card.id}/${card.archived ? 'unarchive' : 'archive'}"><p class="muted">${card.archived ? 'Restore the card to its lane.' : 'Archive keeps the card and its evidence available.'}</p><button class="secondary">${card.archived ? 'Restore card' : 'Archive card'}</button></form></section></aside></main>`,
      ),
    );
  });
  app.post('/cards', async (c) => {
    const p = parse(
      z.strictObject({ laneId: formId, title: textField, summary: z.string().max(50000), companyId: optionalId }),
      await form(c),
    );
    const card = createCard(c.get('ctx'), p);
    return c.redirect(`/cards/${card.id}`, 303);
  });
  app.post('/cards/:id', async (c) => {
    const p = parse(
      z.strictObject({ title: textField, summary: z.string().max(50000), companyId: optionalId, reason: textField }),
      await form(c),
    );
    const cardId = id(c);
    updateCard(
      c.get('ctx'),
      cardId,
      { title: p.title, summary: p.summary, companyId: p.companyId },
      { reason: p.reason },
    );
    return c.redirect(`/cards/${cardId}`, 303);
  });
  app.post('/cards/:id/move', async (c) => {
    const p = parse(z.strictObject({ stageId: formId, reason: textField }), await form(c));
    const cardId = id(c);
    moveCard(c.get('ctx'), cardId, { stageId: p.stageId }, { reason: p.reason });
    return c.redirect(`/cards/${cardId}`, 303);
  });
  for (const [action, fn] of [
    ['archive', archiveCard],
    ['unarchive', unarchiveCard],
  ] as const)
    app.post(`/cards/:id/${action}`, async (c) => {
      parse(z.strictObject({}), await form(c));
      const cardId = id(c);
      fn(c.get('ctx'), cardId);
      return c.redirect(`/cards/${cardId}`, 303);
    });
  app.post('/messages/:id/attach', async (c) => {
    const p = parse(z.strictObject({ cardId: optionalId, reason: textField }), await form(c));
    attachMessage(c.get('ctx'), id(c), p.cardId, { reason: p.reason });
    return c.redirect(p.cardId === null ? '/board' : `/cards/${p.cardId}`, 303);
  });
  app.get('/lanes', (c) =>
    c.html(
      shell(
        'Lanes',
        html`${pageHeading('Lanes & SOPs', 'Each lane defines its own work, ordered stages and entry criteria.')}<main class="two-column"><section><h2>Configured lanes</h2>${listLanes(c.get('ctx'), { includeArchived: true }).map((l) => html`<article class="list-row"><h3><a href="/lanes/${l.id}">${l.name}</a> ${l.archived ? '(archived)' : ''}</h3><p>${l.stages.map((s) => s.name).join(' → ')}</p><p class="muted">${l.sop}</p></article>`)}${listLanes(c.get('ctx')).length ? '' : empty('Create the first lane using the form.')}</section><section><h2>Create lane</h2>${laneForm()}</section></main>`,
        '/lanes',
      ),
    ),
  );
  app.get('/lanes/:id', (c) => {
    const lane = listLanes(c.get('ctx'), { includeArchived: true }).find((l) => l.id === id(c));
    if (!lane) throw new AppError('not_found', 'Lane not found');
    return c.html(
      shell(
        lane.name,
        html`${pageHeading(lane.name, `Lane version ${lane.version}${lane.archived ? ' · Archived' : ''}`)}<main class="form-section">${laneForm(lane)}${!lane.archived ? html`<form method="post" action="/lanes/${lane.id}/archive"><p>Archiving keeps existing cards and prevents new cards in this lane.</p><button class="secondary">Archive lane</button></form>` : ''}</main>`,
        '/lanes',
      ),
    );
  });
  app.post('/lanes', async (c) => {
    const lane = createLane(c.get('ctx'), parseLane(await form(c)));
    return c.redirect(`/lanes/${lane.id}`, 303);
  });
  app.post('/lanes/:id', async (c) => {
    const laneId = id(c);
    updateLane(c.get('ctx'), laneId, parseLane(await form(c)));
    return c.redirect(`/lanes/${laneId}`, 303);
  });
  app.post('/lanes/:id/archive', async (c) => {
    parse(z.strictObject({}), await form(c));
    archiveLane(c.get('ctx'), id(c));
    return c.redirect('/lanes', 303);
  });
}
