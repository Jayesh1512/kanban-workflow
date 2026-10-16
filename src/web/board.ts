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
  getWorkflowBoard,
  getWorkflowTicket,
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
import { providerReason, providerStatus } from './status.ts';
import { registerWorkflow, workflowFragment, workflowPage } from './workflow.ts';
import { workflowControls, workflowSetup } from './workflow-render.ts';

const stagesSchema = z
  .array(z.strictObject({ id: formId.optional(), name: textField, criteria: z.string().max(20000) }))
  .min(2)
  .max(100);
function laneForm(lane?: ReturnType<typeof listLanes>[number]) {
  const stages = lane?.stages ?? [
    { name: '', criteria: '' },
    { name: '', criteria: '' },
  ];
  return html`<form method="post" action="/lanes${lane ? `/${lane.id}` : ''}" class="stack-form" data-lane-form><label>Lane name<input name="name" value="${lane?.name ?? ''}" required></label><label>Lane purpose &amp; process (SOP)<textarea name="sop" rows="4" required>${lane?.sop ?? ''}</textarea></label><fieldset><legend>Stages in order</legend><p class="muted" id="stage-minimum-${lane?.id ?? 'new'}">Keep at least two stages. Remove is unavailable at two; add a stage to enable removal. Define the entry criteria for each stage after the first. Removing a stage that holds cards is refused.</p><div data-stage-rows>${stages.map((s, index) => html`<div class="stage-editor">${hidden(`stageId${index}`, 'id' in s ? s.id : '')}<label>Stage ${index + 1} name<input name="stageName${index}" value="${s.name}" required></label><label>Entry criteria<textarea name="stageCriteria${index}" rows="2" ${index ? html`required` : ''}>${s.criteria}</textarea></label><button type="button" class="quiet" data-remove-stage aria-describedby="stage-minimum-${lane?.id ?? 'new'}" ${stages.length <= 2 ? html`disabled` : ''}>Remove stage</button></div>`)}</div><button type="button" class="secondary" data-add-stage>Add stage</button></fieldset><button>${lane ? 'Save lane' : 'Create lane'}</button></form>`;
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

function requireGenericCard(c: WebContext, cardId: number): void {
  const ctx = c.get('ctx');
  if (getWorkflowBoard(ctx).lane?.id === getCard(ctx, cardId).laneId)
    throw new AppError('invalid', 'Open the workflow ticket and use its versioned move or restore form.');
}

export function registerBoard(app: WebApp, deps: WebDeps): void {
  registerWorkflow(app);
  const boardPage = (c: WebContext) => {
    const ctx = c.get('ctx');
    const workflow = getWorkflowBoard(ctx);
    if (workflow.lane) return workflowPage(c, deps, workflow);
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
        html`${pageHeading('Pipeline', 'Track deals across the team. Open a deal for its conversation and next steps.', html`<a class="button" href="#create-card" data-open-details>New deal</a>`)}
      <header id="status" class="status-strip" data-automatic-off="${Number(threshold >= 1)}" data-pipeline-state="${pipeline.state}" data-pipeline-reason="${pipeline.reason ?? ''}" data-open-review="${board.openReviewCount}" data-movement-state="${pipeline.movement.state}" data-movement-reason="${pipeline.movement.reason ?? ''}"><div><strong>${threshold >= 1 ? 'You approve suggestions before they change the pipeline.' : 'Automatic actions above the review threshold are enabled.'}</strong>${pipeline.pending > 0 ? html`<p>${pipeline.pending} messages awaiting analysis.</p>` : ''}<p><a class="review-link" href="/review">${board.openReviewCount} ${board.openReviewCount === 1 ? 'suggestion to review' : 'suggestions to review'}</a></p>${pipeline.reason || deps.model.blocked ? html`<p class="warning-text">General analysis: ${providerReason(deps.model.blocked ?? pipeline.reason)}. <a href="/settings#ai-status">Check AI settings</a></p>` : pipeline.modelFailure ? html`<p class="warning-text">Last analysis: ${providerReason(pipeline.modelFailure)}. <a href="/review">Review available suggestions</a></p>` : ''}${pipeline.movement.reason ? html`<p class="warning-text">Cross-lane suggestions: ${providerReason(pipeline.movement.reason)}. Manual moves remain available.</p>` : ''}<details><summary>AI status &amp; approval policy</summary><p>${threshold >= 1 ? 'Automatic actions are off.' : ''} ${threshold >= 1 ? 'Decisions wait for human review.' : 'Every cross-lane move still needs human review.'} Threshold: ${threshold}. <a href="/review">${board.openReviewCount} stored review items${reviewAvailable ? '' : ' · queue unavailable'}</a></p><p>To change automatic behavior, adjust the <a href="/settings#review-threshold">review threshold in Settings</a>. Confidence has not been measured. Cross-lane moves always need human approval; lowering the threshold does not configure providers.</p>${providerStatus(deps)}</details></div></header>
      ${counts === null ? '' : html`<aside id="my-chats" class="chat-summary" data-connected="${Number(counts.connected)}" data-undecided="${counts.undecidedRecent ?? ''}" data-out-of-date="${counts.agreementOutOfDate}"><strong>Your chat choices</strong><span>${counts.undecidedRecent === null ? 'Undecided chat count is unknown.' : `${counts.undecidedRecent} recent undecided chats.`} ${counts.agreementOutOfDate} confirmations out of date.</span>${accounts.map((a) => html`<a href="/settings/accounts/${a.id}/chats">${a.label}: choose chats</a>`)}</aside>`}
      ${board.lanes.every((l) => l.cards.length === 0) ? html`<section class="empty-state"><h2>No active deals yet</h2>${board.openReviewCount > 0 ? html`<p>Review the waiting suggestions to decide what belongs on your pipeline.</p><a class="button" href="/review">Review suggestions</a>` : !accounts.length ? html`<p>Connect your account, then choose which chats to include. Relevant conversations can become deal suggestions for your review.</p><a class="button" href="/settings/accounts">Connect an account</a>` : counts && !counts.connected ? html`<p>Your account is disconnected. Reconnect to receive new messages, or create a deal manually.</p><a class="button" href="/settings/accounts">Check your connection</a>` : counts?.undecidedRecent ? html`<p>You have chats waiting for a choice. Include only the conversations you want to share; relevant messages can lead to deal suggestions.</p><a class="button" href="/settings/accounts">Choose included chats</a>` : html`<p>No suggestions are waiting. Relevant new messages from included chats can lead to deal suggestions. You can also create a deal manually.</p><a class="button" href="/settings/accounts">Review included chats</a>`}</section>` : ''}
      <main id="board" data-version="${board.version}">${boardLanes(board)}</main>${workflowSetup()}
      <details id="create-card" class="form-section disclosure"><summary>Create a deal manually</summary><p class="muted">Use this when you already know the deal. You can attach supporting messages from its detail page.</p>${lanes.length ? html`<form method="post" action="/cards" class="stack-form"><label>Title<input name="title" required></label><label>Lane<select name="laneId" required>${lanes.map((l) => html`<option value="${l.id}">${l.name}</option>`)}</select></label><p class="muted">Starts in the selected lane's first stage. You can move it from the detail page.</p><label>Summary<textarea name="summary" rows="3"></textarea></label><label>Company<select name="companyId"><option value="">Unknown</option>${searchCompanies(ctx, { limit: Number.MAX_SAFE_INTEGER }).map((co) => html`<option value="${co.id}">${co.name}</option>`)}</select></label><button>Create deal</button></form>` : html`<p><a href="/lanes">Create a lane first</a> with its SOP and stages.</p>`}</details>`,
      ),
    );
  };
  app.get('/', boardPage);
  app.get('/board', boardPage);
  app.get('/board/fragment', (c) => {
    const workflow = getWorkflowBoard(c.get('ctx'));
    return c.html(workflow.lane ? workflowFragment(c, workflow) : boardLanes(getBoard(c.get('ctx'))));
  });
  app.get('/board/version', (c) => c.json({ version: boardVersion(c.get('ctx').db) }));
  app.get('/cards/:id', (c) => {
    const ctx = c.get('ctx');
    const card = getCard(ctx, id(c));
    const workflow = getWorkflowBoard(ctx);
    const ticket = workflow.lane?.id === card.laneId ? getWorkflowTicket(ctx, card.id) : null;
    const lanes = listLanes(ctx);
    const lane = listLanes(ctx, { includeArchived: true }).find((l) => l.id === card.laneId);
    return c.html(
      shell(
        card.title,
        html`<nav class="breadcrumb" aria-label="Breadcrumb"><a href="/board">Pipeline</a><span>${lane?.name ?? 'Unknown lane'} / ${lane?.stages.find((s) => s.id === card.stageId)?.name ?? 'Unknown stage'}</span></nav>${pageHeading(card.title, card.archived ? 'Archived deal' : 'Deal details')}
      <main class="detail-layout"><div class="evidence-column"><section><h2>Summary</h2><p class="prose">${card.summary || 'No summary recorded.'}</p>${card.hasGap ? html`<p class="notice">This card has a history gap. Its linked messages may be incomplete.</p>` : ''}</section><section><h2>Linked messages <span class="count">${card.messages.length}</span></h2><p class="muted">In time order, from the stored conversations.</p>${messages(card.messages, searchCards(ctx, { limit: Number.MAX_SAFE_INTEGER }).cards)}</section><details class="disclosure"><summary>Known-company references</summary>${references(card.references)}</details><details class="disclosure"><summary>History &amp; human corrections</summary>${logEntries(card.history)}</details></div>
      <aside class="detail-sidebar">${ticket ? workflowControls(ticket, workflow) : ''}<section><h2>Context</h2>${cardMetadata(card)}</section><details class="disclosure" id="edit-deal"><summary>Edit deal</summary><form method="post" action="/cards/${card.id}">${ticket ? hidden('version', ticket.version) : ''}<label>Title<input name="title" value="${card.title}" required></label><label>Summary<textarea name="summary" rows="4">${card.summary}</textarea></label><label>Company<select name="companyId"><option value="">Unknown</option>${searchCompanies(ctx, { limit: Number.MAX_SAFE_INTEGER }).map((co) => html`<option value="${co.id}" ${co.id === card.company?.id ? html`selected` : ''}>${co.name}</option>`)}</select></label><label>Correction reason<input name="reason" required></label><button>Save correction</button></form></details>
      ${!ticket && !card.archived ? html`<details class="disclosure"><summary>Move deal</summary><form method="post" action="/cards/${card.id}/move"><label>Lane / stage<select name="stageId">${lanes.map((l) => html`<optgroup label="${l.name}">${l.stages.map((s) => html`<option value="${s.id}" ${s.id === card.stageId ? html`selected` : ''}>${s.name}</option>`)}</optgroup>`)}</select></label><label>Reason<input name="reason" required></label><button>Move deal</button></form></details>` : ''}${!ticket ? html`<details class="disclosure"><summary>Archive &amp; restore</summary><form method="post" action="/cards/${card.id}/${card.archived ? 'unarchive' : 'archive'}"><p class="muted">${card.archived ? 'Restore the card to its lane.' : 'Archive keeps the card and its evidence available.'}</p><button class="secondary">${card.archived ? 'Restore deal' : 'Archive deal'}</button></form></details>` : ''}</aside></main>`,
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
      z.strictObject({
        title: textField,
        summary: z.string().max(50000),
        companyId: optionalId,
        reason: textField,
        version: formId.optional(),
      }),
      await form(c),
    );
    const cardId = id(c);
    const ctx = c.get('ctx');
    ctx.db.tx(() => {
      if (getWorkflowBoard(ctx).lane?.id === getCard(ctx, cardId).laneId) {
        if (getWorkflowTicket(ctx, cardId).version !== p.version)
          throw new AppError('conflict', 'Stale ticket version. Reopen the ticket before saving a correction.');
      }
      updateCard(ctx, cardId, { title: p.title, summary: p.summary, companyId: p.companyId }, { reason: p.reason });
    });
    return c.redirect(`/cards/${cardId}`, 303);
  });
  app.post('/cards/:id/move', async (c) => {
    const p = parse(z.strictObject({ stageId: formId, reason: textField }), await form(c));
    const cardId = id(c);
    requireGenericCard(c, cardId);
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
      requireGenericCard(c, cardId);
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
        html`${pageHeading('Pipeline rules', 'Lanes group work. Stages show progress; entry criteria explain when a deal can move.')}<main class="two-column"><section><h2>Configured lanes</h2>${listLanes(c.get('ctx'), { includeArchived: true }).map((l) => html`<article class="list-row"><h3><a href="/lanes/${l.id}">${l.name}</a> ${l.archived ? '(archived)' : ''}</h3><p>${l.stages.map((s) => s.name).join(' → ')}</p><p class="muted">${l.sop}</p></article>`)}${listLanes(c.get('ctx')).length ? '' : empty('Create the first lane using the form.')}</section><section><h2>Create lane</h2>${laneForm()}</section></main>`,
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
