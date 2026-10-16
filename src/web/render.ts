import { html } from 'hono/html';
import type { BoardView, CardSummary, KnownCompanyPanel, LogEntry, MessageView } from '../contracts/index.ts';
import type { Markup } from './shared.ts';
import { empty, hidden, time } from './shared.ts';

export function cardMetadata(card: CardSummary): Markup {
  return html`<dl class="card-meta"><div><dt>Company</dt><dd>${card.company ? html`<a href="/companies/${card.company.id}">${card.company.name}</a>` : 'Unknown'}</dd></div>
    <div><dt>Contacts</dt><dd>${card.contacts.length ? card.contacts.map((p, i) => html`${i ? ', ' : ''}<a href="/contacts/${p.id}">${p.name}</a>`) : 'Unknown'}</dd></div>
    <div><dt>Teammates</dt><dd>${card.teammates.length ? card.teammates.map((p) => p.name).join(', ') : 'No contributing chat'}</dd></div>
    <div><dt>Last message</dt><dd>${time(card.lastMessageAt)}</dd></div>
    <div><dt>Changed by</dt><dd>${card.lastChangeBy === 'agent' ? 'Agent' : card.lastChangeBy === 'teammate' ? 'Teammate' : 'Credential'}</dd></div></dl>
    ${card.fromHistory || card.hasGap || card.archived ? html`<p class="flags">${card.fromHistory ? html`<span>From history</span>` : ''}${card.hasGap ? html`<span class="warning-text">History gap</span>` : ''}${card.archived ? html`<span>Archived</span>` : ''}</p>` : ''}`;
}
export function compactCard(card: CardSummary, level: 3 | 4 = 3): Markup {
  return html`<article class="card" data-card-id="${card.id}" data-lane-id="${card.laneId}" data-stage-id="${card.stageId}" data-company-id="${card.company?.id ?? ''}" data-last-change-by="${card.lastChangeBy}" data-from-history="${Number(card.fromHistory)}" data-has-gap="${Number(card.hasGap)}"><a class="card-title-link" href="/cards/${card.id}"><h3 class="card-title" aria-level="${level}">${card.title}</h3></a>${cardMetadata(card)}</article>`;
}
export function boardLanes(board: BoardView): Markup {
  return html`${
    board.lanes.length
      ? board.lanes.map(
          (lane) =>
            html`<section class="lane" data-lane-id="${lane.id}" data-lane-name="${lane.name}" aria-labelledby="lane-${lane.id}"><div class="lane-heading"><h2 id="lane-${lane.id}"><a href="/lanes/${lane.id}">${lane.name}</a></h2><span class="muted">${lane.cards.length} ${lane.cards.length === 1 ? 'card' : 'cards'}</span><details><summary>SOP & criteria</summary><p class="prose">${lane.sop}</p><dl>${lane.stages.map((s) => html`<dt>${s.name}</dt><dd>${s.criteria || 'No entry criterion specified.'}</dd>`)}</dl></details></div><div class="lane-stages" tabindex="0" role="region" aria-label="${lane.name} stages">${lane.stages.map(
              (stage) => {
                const cards = lane.cards.filter((c) => c.stageId === stage.id);
                return html`<div class="stage" data-stage-id="${stage.id}" data-stage-name="${stage.name}"><div class="stage-heading"><h3>${stage.name}</h3><span class="count" aria-label="${cards.length} cards">${cards.length}</span></div>${cards.length ? cards.map((card) => compactCard(card, 4)) : empty('No deals here yet. Deals appear here when created or moved to this stage.')}</div>`;
              },
            )}</div></section>`,
        )
      : empty('Create a lane with its SOP and stages to start organizing work.')
  }`;
}
export function cardsList(cards: CardSummary[]): Markup {
  return html`<div class="card-list">${cards.length ? cards.map((card) => compactCard(card)) : empty('No matching deals.')}</div>`;
}
export function messages(list: MessageView[], actions: CardSummary[] | false = false): Markup {
  return html`<ol class="messages">${list.length ? list.map((m) => html`<li class="message" data-message-id="${m.id}" data-chat-id="${m.chatId}" data-sender-identity-id="${m.sender.identityId}"><div class="message-heading"><strong>${m.sender.contactId ? html`<a href="/contacts/${m.sender.contactId}">${m.sender.name}</a>` : m.sender.name}</strong><span>${m.direction === 'in' ? 'Incoming' : 'Outgoing'} · ${m.chatTitle}</span>${time(m.sentAt)}<span>Message ${m.id}</span></div><p class="message-text">${m.text === null ? 'Message text unavailable.' : m.deleted && m.text === '' ? 'Message deleted.' : m.text}</p><p class="muted">${m.media ? `Media: ${m.media}. ` : ''}${m.edited ? 'Edited. ' : ''}${m.deleted ? 'Deleted. ' : ''}${m.fromHistory ? 'From history. ' : ''}${m.replyToId ? `Reply to message ${m.replyToId}.` : ''}</p>${actions ? html`<details><summary>Change linked deal</summary><form method="post" action="/messages/${m.id}/attach"><label>Link to deal<select name="cardId"><option value="">None (detach)</option>${m.cardId !== null && !actions.some((card) => card.id === m.cardId) ? html`<option value="${m.cardId}" selected disabled>Current attachment is archived; choose a new card or detach</option>` : ''}${actions.map((card) => html`<option value="${card.id}" ${card.id === m.cardId ? html`selected` : ''}>${card.title}</option>`)}</select></label><label>Correction reason<input name="reason" required></label><button>Save attachment</button></form></details>` : ''}</li>`) : html`<li class="empty">No linked messages.</li>`}</ol>`;
}
function activityLabel(action: string): string {
  const labels: Record<string, string> = {
    'card.create': 'Deal created',
    'card.update': 'Deal corrected',
    'card.move': 'Deal moved',
    'card.archive': 'Deal archived',
    'card.unarchive': 'Deal restored',
    'card.offer_dismiss': 'Deal link dismissed',
    'message.attach': 'Message linked to deal',
    'message.detach': 'Message unlinked',
    'contact.set_company': 'Contact linked to company',
    'contact.remove_company': 'Company link removed',
    'contact.set_role': 'Contact role updated',
    'contact.update': 'Contact name updated',
    'company.create': 'Company created',
    'company.update': 'Company name updated',
    'company.alias': 'Company alias saved',
    'review.accept': 'Suggestion accepted',
    'review.change': 'Suggestion corrected',
    'review.dismiss': 'Suggestion dismissed',
    'review.join': 'Supporting messages added to suggestion',
    'chat.include': 'Chat included',
    'chat.exclude': 'Chat excluded',
    'chat.withdraw': 'Chat withdrawn and imported data removed',
    'chat.agree': 'Chat agreement recorded',
    'chat.agreement_stale': 'Chat confirmation needs renewal',
    'account.connect': 'Account connected',
    'account.disconnect': 'Account disconnected',
    'setting.update': 'Team setting updated',
    'lane.create': 'Pipeline lane created',
    'lane.update': 'Pipeline rules updated',
    'lane.archive': 'Pipeline lane archived',
    'teammate.add': 'Teammate added',
    'teammate.remove': 'Teammate removed',
    'credential.create': 'Agent credential created',
    'credential.revoke': 'Agent credential revoked',
    'reference.record': 'Company reference saved',
    'reference.remove': 'Company reference removed',
    'chat.sync_start': 'Chat import started',
    'chat.sync_complete': 'Chat import completed',
    'chat.sync_failure': 'Chat import needs attention',
    'chat.sync_queue': 'Chat import queued',
  };
  return labels[action] ?? 'Activity recorded';
}
export function logEntries(entries: LogEntry[]): Markup {
  return html`<ol class="history">${entries.length ? entries.map((e) => html`<li><div class="message-heading"><strong>${e.actor.name}</strong><span>${activityLabel(e.action)}</span>${time(e.at)}</div><p>${e.redacted ? 'Supporting details removed.' : e.reason || 'No reason recorded.'}</p>${e.correctsId ? html`<p class="muted">Corrects log entry ${e.correctsId}.</p>` : ''}${e.followsHumanOverride ? html`<p>Follows a human override.</p>` : ''}${!e.redacted && (e.before !== null || e.after !== null) ? html`<details><summary>Before and after</summary><div class="history-values"><div><h3>Before</h3><pre>${JSON.stringify(e.before, null, 2)}</pre></div><div><h3>After</h3><pre>${JSON.stringify(e.after, null, 2)}</pre></div></div></details>` : ''}<details><summary>Technical record</summary><p>${e.action} · ${e.subjectKind} ${e.subjectId ?? ''}</p></details>${e.messageIds.length ? html`<p class="muted">Supporting message IDs: ${e.messageIds.join(', ')}</p>` : ''}</li>`) : html`<li class="empty">No recorded changes.</li>`}</ol>`;
}
export function references(panels: KnownCompanyPanel[]): Markup {
  return html`${panels.length ? panels.map((p) => html`<section class="reference"><div class="section-heading"><h3><a href="/companies/${p.company.id}">${p.company.name}</a></h3><form method="post" action="/references/${p.referenceId}/remove">${hidden('companyId', p.company.id)}<button class="quiet">Remove reference</button></form></div><p>Last conversation: ${time(p.lastConversationAt)}</p><ul>${p.contacts.map((c) => html`<li><a href="/contacts/${c.id}">${c.name}</a> · ${c.roleCategory} · ${c.dealsAbout || 'No role detail'}</li>`)}</ul>${messages([p.message])}<h4>Open cards</h4>${cardsList(p.openCards)}</section>`) : empty('No known-company references.')}`;
}
