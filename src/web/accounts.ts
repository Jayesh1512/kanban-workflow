import { html } from 'hono/html';
import { z } from 'zod';
import { getSetting } from '../auth/index.ts';
import type { LoginStep } from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';
import { agreementWording } from '../ingest/index.ts';
import { confirmCompany } from './company-confirmation.ts';
import type { Markup, WebApp, WebContext, WebDeps } from './shared.ts';
import { empty, form, formId, hidden, id, optionalId, pageHeading, parse, shell, textField, time } from './shared.ts';

function loginStep(step: LoginStep, accountId: number): Markup {
  if (step.kind === 'done')
    return html`<p class="notice">Account connected. Choose the chats to include.</p><a href="/settings/accounts/${accountId}/chats">Choose chats</a>`;
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
    return c.html(
      shell(
        'Your accounts',
        html`${pageHeading('Your connected accounts', 'Only you can manage your connections and choose chats.')}<main class="two-column"><section><h2>Your connections</h2>${accounts.length ? accounts.map((a) => html`<article class="list-row"><div class="section-heading"><h3>${a.label}</h3><span>${a.state}</span></div>${steps.has(a.id) && a.state !== 'removed' ? loginStep(steps.get(a.id) as LoginStep, a.id) : ''}${a.state !== 'removed' ? html`<p><a href="/settings/accounts/${a.id}/chats">Choose chats</a></p><details><summary>Disconnect account</summary><p>Disconnect stops ingestion and keeps stored messages. It is different from withdrawing a chat.</p><form method="post" action="/settings/accounts/${a.id}/disconnect"><label class="check"><input type="checkbox" name="confirm" required>Disconnect this account</label><button class="secondary">Disconnect account</button></form></details>` : ''}${a.gaps.length ? html`<h4>History gaps</h4><ul>${a.gaps.map((g) => html`<li>${g.chatTitle}: ${time(g.fromTime)} – ${time(g.toTime)} · ${g.abandoned ? 'Abandoned' : 'Open'}</li>`)}</ul>` : ''}</article>`) : empty('Connect an account, then deliberately include its chats.')}</section><section><h2>Connect account</h2>${deps.host.listChannels().map((channel) => html`<form method="post" action="/settings/accounts" class="connection-form"><h3>${channel.label}</h3>${hidden('channel', channel.channel)}${channel.loginNotice ? html`<p class="prose">${channel.loginNotice.text}</p><label class="check"><input type="checkbox" name="acknowledgedNoticeVersion" value="${channel.loginNotice.version}" required>I acknowledge this notice (version ${channel.loginNotice.version})</label>` : hidden('acknowledgedNoticeVersion', '')}<button>Connect ${channel.label}</button></form>`)}</section></main>`,
        '/settings',
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
        html`${pageHeading(`${account.label} · Your chats`, 'Chat titles and activity only. Message content stays private until you include a chat.')}<main><p class="prose">Including fetches the previous 7 days, up to 200 messages. Excluding stops ingestion and keeps stored messages. Your statement records your confirmation; the product cannot verify participant agreement.</p><p class="notice">Chat withdrawal is unavailable in this build. Exclusion does not remove stored messages.</p>${chats.length ? chats.map((ch) => html`<article class="chat-row"><div class="section-heading"><h2>${ch.title}</h2><span>${ch.kind} · ${ch.decision}</span></div><p class="muted">Latest message: ${time(ch.latestAt)}</p>${ch.withdrawnAt ? html`<p>Withdrawn by ${ch.withdrawnBy ?? 'Unknown'} at ${time(ch.withdrawnAt)}.</p>` : ''}${ch.agreementOutOfDate ? html`<p class="warning-text">Confirmation out of date. A new outside participant has written; ingestion continues.</p>` : ''}${ch.decision === 'included' ? html`<form method="post" action="/settings/accounts/${accountId}/chats/exclude">${hidden('chatKey', ch.key)}<button class="secondary">Exclude chat</button></form>${ch.agreementOutOfDate && ch.chatId !== null ? html`<form method="post" action="/settings/accounts/${accountId}/chats/${ch.chatId}/confirm"><p class="prose">${wording.text}</p><label class="check"><input type="checkbox" name="agreedWordingVersion" value="${wording.version}" required>I confirm this statement again</label><button>Reconfirm agreement</button></form>` : ''}` : html`<details><summary>Include chat</summary><form method="post" action="/settings/accounts/${accountId}/chats/include">${hidden('chatKey', ch.key)}<label>Company name (optional)<input name="company"></label>${required || ch.decision === 'withdrawn' ? html`<p class="prose">${wording.text}</p><label class="check"><input type="checkbox" name="agreedWordingVersion" value="${wording.version}" required>I confirm this statement (version ${wording.version})</label>` : hidden('agreedWordingVersion', '')}<button>Include chat</button></form></details>`}${records.some((r) => r.chatKey === ch.key) ? html`<details><summary>Agreement records</summary><ol>${records.filter((r) => r.chatKey === ch.key).map((r) => html`<li>${r.name} · ${r.kind} · version ${r.version} · ${time(r.at)}<p class="prose">${r.wording}</p></li>`)}</ol></details>` : ''}</article>`) : empty('No chats are currently listed for this account.')}</main>`,
        '/settings',
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
    if (confirmation.page) return c.html(shell('Confirm company', confirmation.page, '/settings'));
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
