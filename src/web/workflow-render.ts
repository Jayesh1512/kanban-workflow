import { html } from 'hono/html';
import type { WorkflowBoard, WorkflowTicket, WorkflowWorkstream } from '../contracts/index.ts';
import type { Markup } from './shared.ts';
import { empty, hidden } from './shared.ts';

export const workstreams: { key: WorkflowWorkstream; name: string }[] = [
  { key: 'buyer', name: 'Buyer' },
  { key: 'provider', name: 'Provider' },
  { key: 'integration', name: 'Integration' },
  { key: 'others', name: 'Others' },
];
export function workstreamSelect(value: WorkflowWorkstream = 'others'): Markup {
  return html`<label>Workstream<select name="workstream">${workstreams.map((w) => html`<option value="${w.key}" ${w.key === value ? html`selected` : ''}>${w.name}</option>`)}</select></label>`;
}
export function followUpTime(at: string | null, timeZone: string): Markup {
  if (at === null) return html`<span>Not scheduled</span>`;
  const label = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
    hour12: false,
  }).format(new Date(at));
  return html`<time datetime="${at}" title="${at}">${label} (${timeZone})</time>`;
}
export function workflowCard(ticket: WorkflowTicket, timeZone: string): Markup {
  return html`<article class="card workflow-card" data-card-id="${ticket.card.id}" data-workstream="${ticket.workstream}"><a class="card-title-link" href="/cards/${ticket.card.id}"><h3 class="card-title">${ticket.card.title}</h3></a><span class="workflow-badge">${workstreams.find((w) => w.key === ticket.workstream)?.name}</span><dl><div><dt>Next action</dt><dd>${ticket.nextAction || 'Choose a next action'}</dd></div><div><dt>Follow-up</dt><dd>${followUpTime(ticket.followUpAt, timeZone)}</dd></div>${ticket.blockedReason ? html`<div><dt>Block reason</dt><dd>${ticket.blockedReason}</dd></div>` : ''}${ticket.buyerId ? html`<div><dt>Buyer reference</dt><dd>${ticket.buyerId}</dd></div>` : ''}</dl></article>`;
}
export function workflowColumns(board: WorkflowBoard, workstream = '', archive = false): Markup {
  const tickets = board.tickets.filter((t) => !workstream || t.workstream === workstream);
  const stages = board.stages.filter((s) => (s.key === 'archive') === archive);
  return html`<div class="workflow-stages" tabindex="0" role="region" aria-label="Partnership workflow stages">${stages.map(
    (stage) => {
      const cards = tickets.filter((t) => t.workflowStage === stage.key);
      return html`<section class="stage" data-workflow-stage="${stage.key}"><div class="stage-heading"><h2>${stage.name}</h2><span class="count">${cards.length}</span></div>${cards.length ? cards.map((t) => workflowCard(t, board.timeZone)) : empty(archive ? 'No archived tickets match this filter.' : 'No tickets in this stage.')}</section>`;
    },
  )}</div>`;
}
export function workflowSetup(): Markup {
  return html`<details class="disclosure form-section"><summary>Set up Enterprise &amp; partnerships</summary><p>Create one workflow with Buyer, Provider, Integration and Others workstreams. Existing lanes and cards are kept.</p><p>Setup enables evidence-based workflow actions strictly above 0.85 confidence. Human corrections remain authoritative; moves between existing lanes still need human approval. General review settings stay unchanged.</p><form method="post" action="/workflow/configure"><label class="check"><input type="checkbox" name="confirm" required>Enable this workflow and its automation policy</label><button>Set up workflow</button></form></details>`;
}
export function workflowCreate(): Markup {
  return html`<details id="create-card" class="disclosure form-section"><summary>Create a lead or task</summary><p>Starts in To be started. Sending outreach alone does not move it forward. Internal tasks belong in Others.</p><form method="post" action="/workflow/tickets" class="stack-form"><label>Title<input name="title" required maxlength="500"></label><label>Summary<textarea name="summary" rows="3" maxlength="20000"></textarea></label>${workstreamSelect()}<label>Next action<input name="nextAction" maxlength="2000"></label>${followUpInput()}<button>Create ticket</button></form></details><details id="import-leads" class="disclosure form-section"><summary>Import known leads</summary><p>One title per line, up to 100. All start in To be started with the chosen workstream. Duplicate titles, including existing archived tickets, are refused before any are created. Reopen an existing ticket instead.</p><form method="post" action="/workflow/import"><label>Lead titles<textarea name="titles" rows="6" required maxlength="200000"></textarea></label>${workstreamSelect()}<button>Import leads</button></form></details>`;
}
function followUpInput(at: string | null = null): Markup {
  return html`<label>Follow-up time (ISO 8601 with timezone)<input name="followUpAt" value="${at ?? ''}" placeholder="2026-10-19T09:00:00+05:30" aria-describedby="follow-up-help"></label><p class="muted" id="follow-up-help">Use Z or an explicit offset, such as +05:30 for Asia/Kolkata. This is a follow-up reminder time, not a promised completion ETA. Leave blank to clear.</p>`;
}
export function workflowControls(ticket: WorkflowTicket, board: WorkflowBoard): Markup {
  return html`<section><h2>Workflow</h2><p>${board.stages.find((s) => s.key === ticket.workflowStage)?.name} · ${workstreams.find((w) => w.key === ticket.workstream)?.name}</p><dl><dt>Next action</dt><dd>${ticket.nextAction || 'Not set'}</dd><dt>Follow-up</dt><dd>${followUpTime(ticket.followUpAt, board.timeZone)}</dd><dt>Block reason</dt><dd>${ticket.blockedReason || 'No block reason recorded'}</dd><dt>Buyer reference</dt><dd>${ticket.buyerId || 'Not set'}</dd></dl><p class="muted">Buyer ID is a reference only; it does not verify transactions or live usage.</p></section><details class="disclosure" id="workflow-edit"><summary>Edit next action &amp; workflow fields</summary><form method="post" action="/workflow/tickets/${ticket.card.id}">${hidden('version', ticket.version)}${workstreamSelect(ticket.workstream)}<label>Next action<input name="nextAction" value="${ticket.nextAction ?? ''}" maxlength="2000"></label>${followUpInput(ticket.followUpAt)}<label>Block reason<textarea name="blockedReason" maxlength="2000">${ticket.blockedReason ?? ''}</textarea></label><label>Buyer ID (reference only)<input name="buyerId" value="${ticket.buyerId ?? ''}" maxlength="2000"></label><button>Save workflow fields</button></form></details><details class="disclosure"><summary>${ticket.card.archived ? 'Restore ticket' : 'Move or archive ticket'}</summary><p>For Blocked, first save a block reason and a next action or follow-up above. Silence alone is a follow-up signal; Archive is an explicit choice.</p><form method="post" action="/workflow/tickets/${ticket.card.id}/move">${hidden('version', ticket.version)}<label>${ticket.card.archived ? 'Restore to stage' : 'Destination'}<select name="to" required><option value="" selected disabled>Choose destination</option>${board.stages.filter((s) => s.key !== ticket.workflowStage && (!ticket.card.archived || s.key !== 'archive')).map((s) => html`<option value="${s.key}">${s.name}</option>`)}</select></label><label>Reason<input name="reason" required maxlength="2000"></label><label>Supporting message IDs (optional)<input name="evidenceMessageIds" placeholder="For example: 12, 18"></label><p class="muted">Choose IDs from the linked messages on this page. Only retained ticket evidence is accepted.</p><button>${ticket.card.archived ? 'Restore ticket' : 'Move ticket'}</button></form></details>`;
}
