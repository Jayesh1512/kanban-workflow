import { html } from 'hono/html';
import { z } from 'zod';
import {
  configureWorkflow,
  createWorkflowTicket,
  getDailyPriorities,
  getWorkflowBoard,
  moveWorkflowTicket,
  updateWorkflowTicket,
} from '../board/index.ts';
import type { WorkflowBoard } from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';
import type { Markup, WebApp, WebContext, WebDeps } from './shared.ts';
import { evidenceField, form, formId, id, pageHeading, parse, shell, textField } from './shared.ts';
import { providerReason, providerStatus } from './status.ts';
import { workflowCard, workflowColumns, workflowCreate, workstreams } from './workflow-render.ts';

const workstreamField = z.enum(['buyer', 'provider', 'integration', 'others']);
const nullableText = z
  .string()
  .trim()
  .max(2000)
  .transform((v) => v || null);
const followUpField = z.union([z.literal('').transform(() => null), z.iso.datetime({ offset: true })]);
const normalized = (title: string) => title.normalize('NFKC').trim().toLowerCase();
function filters(c: WebContext) {
  return parse(
    z.object({ workstream: z.union([z.literal(''), workstreamField]), view: z.enum(['active', 'archive']) }),
    { workstream: c.req.query('workstream') ?? '', view: c.req.query('view') ?? 'active' },
  );
}
export function workflowFragment(c: WebContext, board: WorkflowBoard): Markup {
  const filter = filters(c);
  return workflowColumns(board, filter.workstream, filter.view === 'archive');
}
export function workflowPage(c: WebContext, deps: WebDeps, board: WorkflowBoard): Response | Promise<Response> {
  const filter = filters(c);
  const pipeline = deps.pipeline.status();
  return c.html(
    shell(
      'Enterprise & partnerships',
      html`${pageHeading('Enterprise & partnerships', 'One pipeline for sales, partnerships, integration and internal work.', html`<a class="button" href="#create-card" data-open-details>New ticket</a>`)}<nav class="section-nav" aria-label="Workflow tools"><a href="/workflow/priorities">What’s important today</a><a href="/board?view=archive">Archive</a><a href="/settings/credentials#hermis-setup">Hermis setup</a><a href="/review">Review suggestions</a></nav><aside class="status-strip"><div><p>${board.automatic ? `Workflow automation is enabled strictly above ${board.confidenceThreshold} confidence, with retained evidence and human override checks.` : 'Workflow actions wait for review.'}</p><p>Dates use ${board.timeZone}. No automatic reminder messages are scheduled.</p>${pipeline.movement.reason ? html`<p class="warning-text">Jev: ${providerReason(pipeline.movement.reason)}. Manual workflow actions remain available.</p>` : ''}<details><summary>Provider status</summary>${providerStatus(deps, true)}</details></div></aside><form method="get" action="/board" class="workflow-filter"><label>Workstream<select name="workstream"><option value="">All workstreams</option>${workstreams.map((w) => html`<option value="${w.key}" ${w.key === filter.workstream ? html`selected` : ''}>${w.name}</option>`)}</select></label><label>View<select name="view"><option value="active" ${filter.view === 'active' ? html`selected` : ''}>Active pipeline</option><option value="archive" ${filter.view === 'archive' ? html`selected` : ''}>Archive</option></select></label><button class="secondary">Apply filters</button></form><main id="board">${workflowColumns(board, filter.workstream, filter.view === 'archive')}</main><details class="disclosure form-section"><summary>When tickets move</summary><p>To be started: seeded leads and outreach without substantive engagement. Work in progress: substantive interest, engineering assessment or active discussion. Integrations: they actually test or run an integration. Completed: confirmed full integration or live use, with evidence.</p><p>Blocked needs a reason, next action and follow-up. Archive is an explicit choice, never an automatic consequence of silence.</p><p class="prose">${board.lane?.sop}</p></details>${workflowCreate()}`,
    ),
  );
}
export function registerWorkflow(app: WebApp): void {
  app.post('/workflow/configure', async (c) => {
    parse(z.strictObject({ confirm: z.literal('on') }), await form(c), 'Confirm workflow setup and automation.');
    configureWorkflow(c.get('ctx'));
    return c.redirect('/board', 303);
  });
  app.post('/workflow/tickets', async (c) => {
    const p = parse(
      z.strictObject({
        title: textField.max(500),
        summary: z.string().max(20000),
        workstream: workstreamField,
        nextAction: nullableText,
        followUpAt: followUpField,
      }),
      await form(c),
      'Enter a title, workstream and a valid ISO 8601 follow-up with timezone.',
    );
    const ctx = c.get('ctx');
    const ticket = ctx.db.tx(() => {
      if (getWorkflowBoard(ctx).tickets.some((t) => normalized(t.card.title) === normalized(p.title)))
        throw new AppError('conflict', 'A ticket with this title already exists. Find it on the board or in Archive.');
      return createWorkflowTicket(ctx, p);
    });
    return c.redirect(`/cards/${ticket.card.id}`, 303);
  });
  app.post('/workflow/import', async (c) => {
    const p = parse(
      z.strictObject({
        titles: z
          .string()
          .max(200000)
          .transform((s) =>
            s
              .split(/\r?\n/)
              .map((v) => v.trim())
              .filter(Boolean),
          )
          .pipe(z.array(textField.max(500)).min(1).max(100)),
        workstream: workstreamField,
      }),
      await form(c),
      'Enter 1–100 lead titles, one per line, and a valid workstream.',
    );
    const ctx = c.get('ctx');
    ctx.db.tx(() => {
      const names = new Set(getWorkflowBoard(ctx).tickets.map((t) => normalized(t.card.title)));
      for (const title of p.titles) {
        const key = normalized(title);
        if (names.has(key))
          throw new AppError(
            'conflict',
            'Duplicate lead title. Nothing imported; remove duplicates or open the existing ticket, including Archive.',
          );
        names.add(key);
      }
      for (const title of p.titles) createWorkflowTicket(ctx, { title, workstream: p.workstream });
    });
    return c.redirect('/board', 303);
  });
  app.post('/workflow/tickets/:id', async (c) => {
    const p = parse(
      z.strictObject({
        version: formId,
        workstream: workstreamField,
        nextAction: nullableText,
        followUpAt: followUpField,
        blockedReason: nullableText,
        buyerId: nullableText,
      }),
      await form(c),
      'Check workflow fields and use an ISO 8601 follow-up with Z or a timezone offset.',
    );
    updateWorkflowTicket(c.get('ctx'), id(c), p);
    return c.redirect(`/cards/${id(c)}`, 303);
  });
  app.post('/workflow/tickets/:id/move', async (c) => {
    const p = parse(
      z.strictObject({
        version: formId,
        to: z.enum(['to_be_started', 'work_in_progress', 'integrations', 'blocked', 'completed', 'archive']),
        reason: textField,
        evidenceMessageIds: evidenceField,
      }),
      await form(c),
      'Choose a destination and explain the move. Reopen the ticket if its version changed.',
    );
    moveWorkflowTicket(c.get('ctx'), id(c), p);
    return c.redirect(`/cards/${id(c)}`, 303);
  });
  app.get('/workflow/priorities', (c) => {
    const board = getWorkflowBoard(c.get('ctx'));
    if (!board.lane) return c.redirect('/board', 303);
    const priorities = getDailyPriorities(c.get('ctx'));
    return c.html(
      shell(
        'Today’s priorities',
        html`${pageHeading('What’s important today', `Follow-up dates in ${board.timeZone}. These are next actions, not completion promises.`)}<nav class="section-nav"><a href="/board">Pipeline</a><a href="/settings/credentials#hermis-setup">Ask through Hermis</a></nav><p>As of ${priorities.asOf}</p><main>${(
          [
            ['Overdue', priorities.overdue],
            ['Due today', priorities.dueToday],
            ['Blocked', priorities.blocked],
            ['Upcoming', priorities.upcoming],
          ] as const
        ).map(
          ([name, tickets]) =>
            html`<section><h2>${name}</h2><div class="card-list">${tickets.length ? tickets.map((ticket) => workflowCard(ticket, board.timeZone)) : html`<p class="empty">No ${name.toLowerCase()} follow-ups.</p>`}</div></section>`,
        )}</main>`,
      ),
    );
  });
}
