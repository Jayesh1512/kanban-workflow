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
import { getWorkflowBoard } from '../board/index.ts';
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
        html`${pageHeading('Settings', 'Manage your connections, check AI status, and adjust team settings.')}<nav class="section-nav" aria-label="Settings"><a href="/settings/accounts">Your connections &amp; included chats</a><a href="/settings/teammates">Teammates</a><a href="/settings/credentials">Agent access (MCP)</a></nav><main><section class="setup-summary"><h2>Start with your conversations</h2><p>Connect your Telegram account and choose the chats to include. Connection alone does not include any chat.</p><a href="/settings/accounts">Manage your connections</a></section>${providerDetails(deps, Boolean(getWorkflowBoard(ctx).lane))}<details class="disclosure settings-advanced" id="team-settings"><summary>Advanced team settings</summary><section><h2>Review &amp; data policy</h2><form method="post" action="/settings"><label for="review-threshold">Review threshold<input id="review-threshold" type="number" name="review_threshold" min="0" max="1" step="0.01" value="${getSetting<number>(ctx.db, 'review_threshold')}" required></label><p class="muted">At 1, every decision waits for review. Lowering it permits automatic actions whose model score is strictly above the threshold. Cross-lane moves always need human approval. Model confidence has not been measured.</p><label class="check"><input type="checkbox" name="keep_deleted_text" ${getSetting<boolean>(ctx.db, 'keep_deleted_text') ? html`checked` : ''}>Keep the text of messages marked deleted</label><label>Role categories (one per line)<textarea name="role_categories" rows="8" required>${getSetting<string[]>(ctx.db, 'role_categories').join('\n')}</textarea></label><p class="muted">Include “unknown”. Categories must be unique.</p><button>Save settings</button></form><section><h2>Access from other machines</h2><p class="prose">Passwords and MCP credentials travel unencrypted unless a TLS proxy is placed in front of this server. Configure TLS before exposing it to other machines.</p></section></section></details></main>`,
        '/settings',
      ),
    );
  });
  app.post('/settings', async (c) => {
    const p = parse(
      z.strictObject({
        review_threshold: z.string().min(1).transform(Number).pipe(z.number().finite().min(0).max(1)),
        require_agreement: checkField.optional(),
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
      for (const [key, value] of Object.entries(p)) if (value !== undefined) setSetting(ctx, key, value);
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
        html`${pageHeading('MCP credentials', 'Agent access for Hermis and other MCP clients. Message text and workflow writes are separate permissions.')}<main><section id="hermis-setup" class="form-section"><h2>Connect Hermis</h2><p>Use the authenticated MCP endpoint <code>${deps.config.origin}/mcp</code> in your MCP client and send the credential as an Authorization: Bearer header. Keep it in your client’s secret configuration.</p><p>Read tools: get_board, list_tickets, get_ticket and get_daily_priorities. Ask “what’s important today” to get overdue, today, blocked and upcoming follow-ups. Message text requires its own permission.</p><p>Write tools: create_ticket, update_ticket and move_ticket. To use them, explicitly enable workflow writes below. Update and move tools require the current ticket version; move also requires a reason. Revoking a credential ends its access.</p><p>No external Hermis instance is confirmed connected. Monday reminder requests can read priorities through the client; this board does not schedule or send reminder messages.</p><a href="/workflow/priorities">View daily priorities</a></section>${flash && flash.expires >= deps.now().getTime() ? html`<section class="notice"><h2>Copy your credential now</h2><p>This token is shown once. It grants the access you selected; keep it private.</p><code class="credential-token">${flash.token}</code></section>` : ''}<div class="two-column"><section><h2>Credentials</h2><ul class="entity-list">${credentials.map((t) => html`<li><span><strong>${t.name}</strong> · Created by ${t.createdBy}<br>${t.scopeMessages ? 'Message text allowed' : 'Message text hidden'} · ${t.scopeWrite ? 'Workflow writes allowed' : 'Read only'} · ${t.revoked ? 'Revoked' : 'Active'}</span>${!t.revoked ? html`<form method="post" action="/settings/credentials/${t.id}/revoke"><button class="quiet">Revoke credential</button></form>` : ''}</li>`)}</ul>${credentials.length ? '' : html`<p class="empty">No credentials created.</p>`}</section><section><h2>Create credential</h2><form method="post" action="/settings/credentials"><label>Name<input name="name" required maxlength="200"></label><label class="check"><input type="checkbox" name="scopeMessages">Allow reading message text</label><label class="check"><input type="checkbox" name="scopeWrite">Allow creating, updating and moving workflow tickets</label><p class="muted">Unchecked means read only. Existing credentials keep their original permissions. Writes are attributed to the credential.</p><button>Create credential</button></form></section></div></main>`,
        '/settings',
      ),
    );
  });
  app.post('/settings/credentials', async (c) => {
    const p = parse(
      z.strictObject({ name: textField.max(200), scopeMessages: checkField, scopeWrite: checkField }),
      await form(c),
    );
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
