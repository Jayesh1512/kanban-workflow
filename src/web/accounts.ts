import { html } from 'hono/html';
import { z } from 'zod';
import { getSetting } from '../auth/index.ts';
import type { LoginStep } from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';
import { agreementWording } from '../ingest/index.ts';
import { withdrawChat } from '../purge/index.ts';
import { confirmCompany } from './company-confirmation.ts';
import type { Markup, WebApp, WebContext, WebDeps } from './shared.ts';
import { empty, form, formId, hidden, id, optionalId, pageHeading, parse, shell, textField, time } from './shared.ts';

function initials(label: string): string {
  const words = label.trim().split(/\s+/u);
  const first = Array.from(words[0] ?? '')[0] ?? '?';
  const last = words.length > 1 ? (Array.from(words.at(-1) ?? '')[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}
function accountState(state: string): string {
  return (
    (
      {
        connecting: 'Connection in progress',
        login: 'Connection in progress',
        auth_lost: 'Connection lost',
        connected: 'Connected',
        disconnected: 'Disconnected',
        removed: 'Disconnected',
        failed: 'Connection failed',
      } as Record<string, string>
    )[state] ?? 'Connection needs attention'
  );
}
function loginStep(step: LoginStep, accountId: number): Markup {
  if (step.kind === 'done') return html`<p class="notice">Account connected. Choose the chats to include.</p>`;
  if (step.kind === 'failed')
    return html`<p role="alert">${step.message}</p><p>${step.retryable ? 'Start the connection again to retry.' : 'The connection could not be completed.'}</p>`;
  return html`<form method="post" action="/settings/accounts/${accountId}/login"><p class="prose">${step.hint}</p>${step.fields.map((f) => html`<label>${f.label}<input name="${f.name}" type="${f.secret ? 'password' : 'text'}" autocomplete="off" required></label>`)}<button>Continue connection</button></form>`;
}
export function registerAccounts(app: WebApp, deps: WebDeps): void {
  const steps = new Map<number, LoginStep>();
  const own = (c: WebContext, accountId: number) => {
    const ctx = c.get('ctx');
    const account = deps.host.listAccounts(ctx).find((a) => a.id === accountId);
    if (!account || ctx.actor.kind !== 'teammate' || account.teammateId !== ctx.actor.id)
      throw new AppError('forbidden', 'Only the account owner can manage this connection.');
    return account;
  };
  app.get('/settings/accounts', (c) => {
    const ctx = c.get('ctx');
    const accounts = deps.host
      .listAccounts(ctx)
      .filter((a) => ctx.actor.kind === 'teammate' && a.teammateId === ctx.actor.id);
    const channels = deps.host.listChannels();
    return c.html(
      shell(
        'Your accounts',
        html`<div class="accounts-page">${pageHeading('Connections', 'Connect your account, then choose the chats to include. Only you can manage these choices.')}<main class="accounts-layout"><section class="accounts-list" aria-labelledby="your-accounts"><div class="accounts-list-heading"><h2 id="your-accounts">Your accounts</h2><p class="muted">Connecting an account does not include its chats. Choose chats separately to import their messages.</p></div>${accounts.length ? accounts.map((a) => html`<article class="account-row"><div class="account-row-heading"><span class="connection-avatar" aria-hidden="true">${initials(a.label)}</span><div class="connection-identity"><h3>${a.label}</h3><p class="account-state" data-account-state="${steps.get(a.id)?.kind === 'failed' ? 'failed' : a.state}">${accountState(steps.get(a.id)?.kind === 'failed' ? 'failed' : a.state)}</p></div>${a.state !== 'removed' ? html`<a class="button" href="/settings/accounts/${a.id}/chats">Choose chats<span class="sr-only"> for ${a.label}</span></a>` : ''}</div><div class="account-row-body">${steps.has(a.id) && a.state !== 'removed' ? loginStep(steps.get(a.id) as LoginStep, a.id) : ''}${a.state !== 'removed' ? html`<details class="account-management"><summary>Disconnect account</summary><p>Disconnect stops ingestion and keeps stored messages. It is different from withdrawing a chat.</p><form method="post" action="/settings/accounts/${a.id}/disconnect"><label class="check"><input type="checkbox" name="confirm" required>Disconnect this account</label><button class="secondary">Disconnect account</button></form></details>` : html`<p class="muted">Connect an account again to choose chats.</p>`}${a.gaps.length ? html`<details><summary>History gaps</summary><ul>${a.gaps.map((g) => html`<li>${g.chatTitle}: ${time(g.fromTime)} – ${time(g.toTime)} · ${g.abandoned ? 'Abandoned' : 'Open'}</li>`)}</ul></details>` : ''}</div></article>`) : empty('No accounts connected yet. Connect an account here, then choose the conversations you want to share with the team.')}</section><aside class="accounts-connect"><details id="connect-account"${accounts.length ? '' : html` open`}><summary>Connect an account</summary><p class="muted">Choose a connection below. You will choose which chats to include after connecting.</p>${channels.length ? channels.map((channel) => html`<form method="post" action="/settings/accounts" class="connection-form"><h3>${channel.label}</h3>${hidden('channel', channel.channel)}${channel.loginNotice ? html`<p class="prose">${channel.loginNotice.text}</p><label class="check"><input type="checkbox" name="acknowledgedNoticeVersion" value="${channel.loginNotice.version}" required>I acknowledge this notice (version ${channel.loginNotice.version})</label>` : hidden('acknowledgedNoticeVersion', '')}<button>Connect ${channel.label}</button></form>`) : empty('No account connections are available. Ask the operator to configure a connector.')}</details></aside></main></div>`,
        '/settings/accounts',
      ),
    );
  });
  app.post('/settings/accounts', async (c) => {
    const p = parse(z.strictObject({ channel: textField, acknowledgedNoticeVersion: optionalId }), await form(c));
    const result = await deps.host.beginLogin(c.get('ctx'), p.channel, {
      acknowledgedNoticeVersion: p.acknowledgedNoticeVersion,
    });
    steps.set(result.accountId, result.step);
    return c.redirect('/settings/accounts', 303);
  });
  app.post('/settings/accounts/:id/login', async (c) => {
    const accountId = id(c);
    own(c, accountId);
    const step = steps.get(accountId);
    if (step?.kind !== 'need_input')
      throw new AppError('conflict', 'No login step is waiting. Start the connection again.');
    const shape: Record<string, z.ZodString> = {};
    for (const field of step.fields) shape[field.name] = z.string().min(1).max(4096);
    const input = parse(z.strictObject(shape), await form(c), 'Complete the requested connection fields.');
    steps.set(accountId, await deps.host.continueLogin(c.get('ctx'), accountId, input));
    return c.redirect('/settings/accounts', 303);
  });
  app.post('/settings/accounts/:id/disconnect', async (c) => {
    const accountId = id(c);
    own(c, accountId);
    parse(z.strictObject({ confirm: z.literal('on') }), await form(c));
    await deps.host.disconnect(c.get('ctx'), accountId);
    steps.delete(accountId);
    return c.redirect('/settings/accounts', 303);
  });
  app.get('/settings/accounts/:id/chats', async (c) => {
    const accountId = id(c);
    const account = own(c, accountId);
    const ctx = c.get('ctx');
    const chats = await deps.host.listChats(ctx, accountId);
    const wording = agreementWording();
    const required = getSetting<boolean>(ctx.db, 'require_agreement');
    const records = ctx.db.all<{
      chatKey: string;
      kind: string;
      wording: string | null;
      version: number | null;
      at: string;
      name: string;
    }>(
      'SELECT a.chat_key AS chatKey,a.kind,a.wording,a.wording_version AS version,a.at,t.display_name AS name FROM chat_agreement a JOIN teammate t ON t.id=a.teammate_id WHERE a.account_id=? ORDER BY a.id DESC',
      accountId,
    );
    return c.html(
      shell(
        'Your chats',
        html`<div class="accounts-page accounts-chats">${pageHeading(`${account.label} · Your chats`, 'Choose which conversations to import. Message content stays private until you include a chat.')}<nav class="section-nav" aria-label="Connection"><a href="/settings/accounts">All connections</a><a href="/review">Review suggestions</a></nav><main class="chat-selection" data-chat-selection><div class="chat-selection-heading"><h2>Choose chats</h2><p class="chat-selection-count">${chats.filter((ch) => ch.decision === 'included').length} of ${chats.length} chats included</p><p class="muted">${accountState(account.state)}</p></div><p class="prose chat-selection-help">Including fetches the previous 7 days, up to 200 messages. Excluding stops ingestion and keeps stored messages. Your statement records your confirmation; the product cannot verify participant agreement.</p>${chats.length ? html`<div class="chat-tools" data-chat-tools hidden><label for="chat-title-search">Search chats<input id="chat-title-search" type="search" placeholder="Search by chat title" autocomplete="off" aria-controls="chat-list" data-chat-search></label><div class="chat-filter-options" role="group" aria-label="Filter chats"><button type="button" data-chat-filter="all" aria-pressed="true" aria-controls="chat-list">All</button><button type="button" data-chat-filter="included" aria-pressed="false" aria-controls="chat-list">Included</button><button type="button" data-chat-filter="not-included" aria-pressed="false" aria-controls="chat-list">Not included</button></div><div class="chat-results"><p role="status" aria-live="polite" aria-atomic="true" data-chat-results></p><button class="quiet" type="button" data-chat-reset>Reset search and filters</button></div></div><div id="chat-list">${chats.map((ch) => html`<article class="chat-row" data-chat-row data-chat-included="${ch.decision === 'included' ? 'true' : 'false'}"><div class="chat-row-heading"><span class="connection-avatar" aria-hidden="true">${initials(ch.title)}</span><div class="connection-identity"><h2 data-chat-title>${ch.title}</h2><p class="chat-decision" data-chat-decision="${ch.decision}">${ch.decision === 'included' ? 'Included · shared with the team' : ch.decision === 'excluded' ? 'Excluded · import stopped' : ch.decision === 'withdrawn' ? 'Withdrawn · imported data removed' : 'Not included yet'}</p></div><p class="chat-latest muted">Latest message: ${time(ch.latestAt)}</p></div><div class="chat-row-body">${ch.withdrawnAt ? html`<p>Withdrawn by ${ch.withdrawnBy ?? 'Unknown'} at ${time(ch.withdrawnAt)}.</p>` : ''}${ch.agreementOutOfDate ? html`<p class="warning-text">Confirmation out of date. A new outside participant has written; ingestion continues.</p>` : ''}<div class="chat-actions">${ch.decision === 'included' ? html`<form method="post" action="/settings/accounts/${accountId}/chats/exclude">${hidden('chatKey', ch.key)}<button class="secondary">Exclude chat</button></form>${ch.chatId !== null ? html`<details class="chat-withdraw"><summary>Withdraw chat and delete imported data</summary><p class="prose" id="withdraw-help-${ch.chatId}">Withdrawal stops this chat through ALL connected accounts and removes its imported app messages and derived data. Shared human values are retained: current human-written card text, contact roles and company values. It does not delete Telegram messages. You will need a new agreement to include the chat again.</p><p class="prose" id="withdraw-global-${ch.chatId}">App-wide cleanup: across OTHER chats too, this deletes saved agent decisions, movement audits, reviews, pending mentions, generated action history and human explanations for moves and reviews. Generated card titles, summaries and contact roles are also cleared wherever they used this chat or their source is unknown. Other chats keep their messages, and retained cards keep their lane and stage. This cleanup cannot be undone.</p><form method="post" action="/settings/accounts/${accountId}/chats/${ch.chatId}/withdraw" aria-describedby="withdraw-help-${ch.chatId} withdraw-global-${ch.chatId}"><label class="check"><input type="checkbox" name="confirm" value="withdraw" required>I confirm withdrawal, deletion of this chat’s imported app data, and the app-wide cleanup across other chats described above</label><button class="danger">Withdraw chat and delete imported data</button></form></details>` : ''}${ch.agreementOutOfDate && ch.chatId !== null ? html`<form method="post" action="/settings/accounts/${accountId}/chats/${ch.chatId}/confirm"><p class="prose">${wording.text}</p><label class="check"><input type="checkbox" name="agreedWordingVersion" value="${wording.version}" required>I confirm this statement again</label><button>Reconfirm agreement</button></form>` : ''}` : html`<details class="chat-include"><summary>Include chat</summary><form method="post" action="/settings/accounts/${accountId}/chats/include">${hidden('chatKey', ch.key)}<label>Company name (optional)<input name="company"></label>${required || ch.decision === 'withdrawn' ? html`<p class="prose">${wording.text}</p><label class="check"><input type="checkbox" name="agreedWordingVersion" value="${wording.version}" required>I confirm this statement (version ${wording.version})</label>` : hidden('agreedWordingVersion', '')}<button>Include chat</button></form></details>`}${ch.decision === 'undecided' ? html`<form method="post" action="/settings/accounts/${accountId}/chats/exclude">${hidden('chatKey', ch.key)}<button class="secondary">Exclude chat</button></form>` : ''}<details class="chat-information"><summary>Chat details</summary><p>${ch.kind} · ${ch.decision}</p>${records.some((r) => r.chatKey === ch.key) ? html`<details><summary>Agreement records</summary><ol>${records.filter((r) => r.chatKey === ch.key).map((r) => html`<li>${r.name} · ${r.kind} · version ${r.version} · ${time(r.at)}<p class="prose">${r.wording}</p></li>`)}</ol></details>` : ''}</details></div></div></article>`)}</div><div class="chat-no-matches" data-chat-no-matches hidden><h3>No chats match these filters</h3><p class="muted">Try another chat title, or reset search and filters to see all chats.</p></div>` : empty('No chats are currently listed for this account. Return to All connections to check the account or connect another one.')}</main></div>`,
        '/settings/accounts',
      ),
    );
  });
  app.post('/settings/accounts/:id/chats/include', async (c) => {
    const accountId = id(c);
    own(c, accountId);
    const ctx = c.get('ctx');
    const p = parse(
      z.strictObject({
        chatKey: textField,
        company: z.string().trim().max(2000),
        agreedWordingVersion: optionalId,
        choice: z.enum(['candidate', 'separate']).optional(),
        challenge: z.string().max(100).optional(),
      }),
      await form(c),
    );
    const confirmation = confirmCompany(
      deps,
      ctx,
      c.req.path,
      { chatKey: p.chatKey, company: p.company, agreedWordingVersion: String(p.agreedWordingVersion ?? '') },
      p.choice,
      p.challenge,
    );
    if (confirmation.page) return c.html(shell('Confirm company', confirmation.page, '/settings/accounts'));
    deps.host.includeChat(ctx, accountId, p.chatKey, {
      company: confirmation.name || null,
      agreedWordingVersion: p.agreedWordingVersion,
    });
    return c.redirect(`/settings/accounts/${accountId}/chats`, 303);
  });
  app.post('/settings/accounts/:id/chats/exclude', async (c) => {
    const accountId = id(c);
    own(c, accountId);
    const p = parse(z.strictObject({ chatKey: textField }), await form(c));
    deps.host.excludeChat(c.get('ctx'), accountId, p.chatKey);
    return c.redirect(`/settings/accounts/${accountId}/chats`, 303);
  });
  app.post('/settings/accounts/:id/chats/:chatId/withdraw', async (c) => {
    const accountId = id(c);
    own(c, accountId);
    parse(
      z.strictObject({ confirm: z.literal('withdraw') }),
      await form(c),
      'Confirm withdrawal and deletion of imported app data.',
    );
    withdrawChat(c.get('ctx'), deps.host, accountId, id(c, 'chatId'));
    return c.redirect(`/settings/accounts/${accountId}/chats`, 303);
  });
  app.post('/settings/accounts/:id/chats/:chatId/confirm', async (c) => {
    const accountId = id(c);
    own(c, accountId);
    const p = parse(z.strictObject({ agreedWordingVersion: formId }), await form(c));
    deps.host.confirmAgreement(c.get('ctx'), accountId, id(c, 'chatId'), {
      agreedWordingVersion: p.agreedWordingVersion,
    });
    return c.redirect(`/settings/accounts/${accountId}/chats`, 303);
  });
}
