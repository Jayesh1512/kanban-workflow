import { createHash } from 'node:crypto';
import { getCookie } from 'hono/cookie';
import { html } from 'hono/html';
import { z } from 'zod';
import {
  addTeammate,
  createCredential,
  getSetting,
  listCredentials,
  listTeammates,
  removeTeammate,
  revokeCredential,
  setSetting,
} from '../auth/index.ts';
import type { WebApp, WebContext, WebDeps } from './shared.ts';
import { checkField, form, id, pageHeading, parse, shell, textField } from './shared.ts';
import { providerDetails } from './status.ts';

export function registerSettings(app: WebApp, deps: WebDeps): void {
  const tokenFlash = new Map<string, { token: string; expires: number }>();
  const sessionKey = (c: WebContext) =>
    createHash('sha256')
      .update(getCookie(c, 'kanban_session') ?? '')
      .digest('hex');
  app.get('/settings', (c) => {
    const ctx = c.get('ctx');
    return c.html(
      shell(
        'Settings',
        html`${pageHeading('Settings', 'Human control, provider availability and team access.')}<nav class="section-nav" aria-label="Settings"><a href="/settings/teammates">Teammates</a><a href="/settings/credentials">MCP credentials</a><a href="/settings/accounts">Your connected accounts</a></nav><main class="two-column"><section><h2>Decision settings</h2><form method="post" action="/settings"><label for="review-threshold">Review threshold<input id="review-threshold" type="number" name="review_threshold" min="0" max="1" step="0.01" value="${getSetting<number>(ctx.db, 'review_threshold')}" required></label><p class="muted">At 1, every decision waits for review. Lowering it allows confident automatic actions. Cross-lane moves always need human approval. Model confidence has not been measured.</p><label class="check"><input type="checkbox" name="require_agreement" ${getSetting<boolean>(ctx.db, 'require_agreement') ? html`checked` : ''}>Require a statement of agreement for each included chat</label><label class="check"><input type="checkbox" name="keep_deleted_text" ${getSetting<boolean>(ctx.db, 'keep_deleted_text') ? html`checked` : ''}>Keep the text of messages marked deleted</label><label>Role categories (one per line)<textarea name="role_categories" rows="8" required>${getSetting<string[]>(ctx.db, 'role_categories').join('\n')}</textarea></label><p class="muted">Include “unknown”. Categories must be unique.</p><button>Save settings</button></form><section><h2>Access from other machines</h2><p class="prose">Passwords and MCP credentials travel unencrypted unless a TLS proxy is placed in front of this server. Configure TLS before exposing it to other machines.</p></section></section>${providerDetails(deps)}</main>`,
        '/settings',
      ),
    );
  });
  app.post('/settings', async (c) => {
    const p = parse(
      z.strictObject({
        review_threshold: z.string().min(1).transform(Number).pipe(z.number().finite().min(0).max(1)),
        require_agreement: checkField,
        keep_deleted_text: checkField,
        role_categories: z
          .string()
          .transform((s) =>
            s
              .split(/\r?\n/)
              .map((r) => r.trim())
              .filter(Boolean),
          )
          .pipe(
            z
              .array(z.string().min(1).max(200))
              .min(1)
              .max(100)
              .refine((r) => r.includes('unknown') && new Set(r).size === r.length),
          ),
      }),
      await form(c),
      'Use a threshold from 0 to 1 and unique role categories including unknown.',
    );
    const ctx = c.get('ctx');
    ctx.db.tx(() => {
      for (const [key, value] of Object.entries(p)) setSetting(ctx, key, value);
    });
    return c.redirect('/settings', 303);
  });
  app.get('/settings/teammates', (c) =>
    c.html(
      shell(
        'Teammates',
        html`${pageHeading('Teammates', 'Existing teammates add accounts. There is no public signup.')}<main class="two-column"><section><h2>Team access</h2><ul class="entity-list">${listTeammates(c.get('ctx')).map((t) => html`<li><span><strong>${t.displayName}</strong> · ${t.username}</span><details><summary>Remove teammate</summary><p>Removal ends their sessions, revokes their credentials and disconnects their accounts. Stored messages stay.</p><form method="post" action="/settings/teammates/${t.id}/remove"><label class="check"><input type="checkbox" name="confirm" required>Remove ${t.displayName}</label><button class="danger">Remove teammate</button></form></details></li>`)}</ul></section><section><h2>Add teammate</h2><form method="post" action="/settings/teammates"><label>Username<input name="username" autocomplete="off" required maxlength="200"></label><label>Display name<input name="displayName" required maxlength="200"></label><label>Initial password<input name="password" type="password" autocomplete="new-password" required maxlength="4096"></label><button>Add teammate</button></form></section></main>`,
        '/settings',
      ),
    ),
  );
  app.post('/settings/teammates', async (c) => {
    const p = parse(
      z.strictObject({
        username: textField.max(200),
        displayName: textField.max(200),
        password: z.string().min(1).max(4096),
      }),
      await form(c),
    );
    addTeammate(c.get('ctx'), p);
    return c.redirect('/settings/teammates', 303);
  });
  app.post('/settings/teammates/:id/remove', async (c) => {
    parse(z.strictObject({ confirm: z.literal('on') }), await form(c), 'Confirm teammate removal.');
    const ctx = c.get('ctx');
    await removeTeammate(ctx, id(c), (accountId) =>
      deps.host.disconnect({ ...ctx, actor: { kind: 'system' } }, accountId),
    );
    return c.redirect('/settings/teammates', 303);
  });
  app.get('/settings/credentials', (c) => {
    const key = sessionKey(c);
    const flash = tokenFlash.get(key);
    tokenFlash.delete(key);
    const credentials = listCredentials(c.get('ctx'));
    return c.html(
      shell(
        'MCP credentials',
        html`${pageHeading('MCP credentials', 'Read access for other agents. Message text is an explicit permission.')}<main>${flash && flash.expires >= deps.now().getTime() ? html`<section class="notice"><h2>Copy your credential now</h2><p>This token is shown once. It grants the access you selected; keep it private.</p><code class="credential-token">${flash.token}</code></section>` : ''}<div class="two-column"><section><h2>Credentials</h2><ul class="entity-list">${credentials.map((t) => html`<li><span><strong>${t.name}</strong> · Created by ${t.createdBy}<br>${t.scopeMessages ? 'Message text allowed' : 'Message text hidden'} · ${t.revoked ? 'Revoked' : 'Active'}</span>${!t.revoked ? html`<form method="post" action="/settings/credentials/${t.id}/revoke"><button class="quiet">Revoke credential</button></form>` : ''}</li>`)}</ul>${credentials.length ? '' : html`<p class="empty">No credentials created.</p>`}</section><section><h2>Create credential</h2><form method="post" action="/settings/credentials"><label>Name<input name="name" required maxlength="200"></label><label class="check"><input type="checkbox" name="scopeMessages">Allow reading message text</label><button>Create credential</button></form></section></div></main>`,
        '/settings',
      ),
    );
  });
  app.post('/settings/credentials', async (c) => {
    const p = parse(z.strictObject({ name: textField.max(200), scopeMessages: checkField }), await form(c));
    const result = createCredential(c.get('ctx'), p);
    for (const [key, flash] of tokenFlash) if (flash.expires < deps.now().getTime()) tokenFlash.delete(key);
    tokenFlash.set(sessionKey(c), { token: result.token, expires: deps.now().getTime() + 60000 });
    return c.redirect('/settings/credentials', 303);
  });
  app.post('/settings/credentials/:id/revoke', async (c) => {
    parse(z.strictObject({}), await form(c));
    revokeCredential(c.get('ctx'), id(c));
    return c.redirect('/settings/credentials', 303);
  });
}
