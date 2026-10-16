import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { html } from 'hono/html';
import { z } from 'zod';
import { signIn, signOut, teammateForSession } from '../auth/index.ts';
import { AppError } from '../contracts/index.ts';
import { registerAccounts } from './accounts.ts';
import { registerBoard } from './board.ts';
import { registerGraph } from './graph.ts';
import { registerReview } from './review.ts';
import { routeInventory } from './routes.ts';
import { registerSettings } from './settings.ts';
import type { WebDeps, WebEnv } from './shared.ts';
import { form, pageHeading, parse, shell, unavailable } from './shared.ts';

export function createWeb(deps: WebDeps): {
  fetch(req: Request): Promise<Response>;
  routes: { method: string; path: string; public: boolean }[];
} {
  const app = new Hono<WebEnv>();
  const routes = routeInventory();
  const css = readFileSync(new URL('./static/app.css', import.meta.url), 'utf8');
  const js = readFileSync(new URL('./static/app.js', import.meta.url), 'utf8');
  app.use('*', async (c, next) => {
    c.header('Content-Security-Policy', "default-src 'self'");
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
    if (c.req.method === 'POST' && c.req.header('Origin') !== deps.config.origin)
      return c.html(
        shell(
          'Origin refused',
          html`<h1>Origin refused</h1><p>Submit forms from the configured team board address.</p>`,
          '/board',
          false,
        ),
        403,
      );
    const isPublic = routes.some((r) => r.public && r.method === c.req.method && r.path === c.req.path);
    if (!isPublic) {
      const token = getCookie(c, 'kanban_session');
      const teammate = token ? teammateForSession(deps.db, token, deps.now()) : null;
      if (teammate === null)
        return c.req.method === 'GET' ? c.redirect('/login', 303) : c.text('Sign-in required', 401);
      c.set('ctx', { db: deps.db, now: deps.now, actor: { kind: 'teammate', id: teammate }, canReadText: true });
    }
    await next();
  });
  app.onError((error, c) => {
    const expected = error instanceof AppError;
    const statuses = { unauthenticated: 401, forbidden: 403, not_found: 404, invalid: 422, conflict: 409 } as const;
    if (!expected) deps.oplog('error', 'web.failed', { code: 'internal' });
    const message = expected ? error.message : 'Internal error. Try again or contact the team administrator.';
    return c.html(
      shell(
        'Request could not be completed',
        html`<main class="error-page"><h1>Request could not be completed</h1><p role="alert">${message}</p><p>Nothing was confirmed by this response. Reopen the latest page and check its current state before trying again.</p><p><a href="/review">Review current suggestions</a> · <a href="/settings/accounts">Manage connections</a></p><a href="${c.req.path === '/login' ? '/login' : '/board'}">${c.req.path === '/login' ? 'Return to sign in' : 'Return to board'}</a></main>`,
        '/board',
        Boolean(c.get('ctx')),
      ),
      expected ? statuses[error.code] : 500,
    );
  });
  app.get('/login', (c) =>
    c.html(
      shell(
        'Sign in',
        html`<main class="login"><h1>Sign in</h1><p class="muted">Track deals and review suggestions from your team’s conversations.</p><form method="post" action="/login"><label>Username<input name="username" autocomplete="username" maxlength="200" required autofocus></label><label>Password<input name="password" type="password" autocomplete="current-password" maxlength="4096" required></label><button>Sign in</button></form><p class="muted">An existing teammate can add your account.</p></main>`,
        '/board',
        false,
      ),
    ),
  );
  app.post('/login', async (c) => {
    const p = parse(
      z.strictObject({ username: z.string().min(1).max(200), password: z.string().min(1).max(4096) }),
      await form(c),
      'Enter your username and password.',
    );
    const session = signIn(deps.db, p.username, p.password, deps.now());
    setCookie(c, 'kanban_session', session.token, {
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure: deps.config.origin.startsWith('https:'),
      maxAge: 14 * 86400,
      expires: new Date(session.expiresAt),
    });
    return c.redirect('/board', 303);
  });
  app.post('/logout', (c) => {
    signOut(deps.db, getCookie(c, 'kanban_session') ?? '');
    deleteCookie(c, 'kanban_session', { path: '/' });
    return c.redirect('/login', 303);
  });
  app.get('/static/app.css', (c) => c.body(css, 200, { 'Content-Type': 'text/css; charset=utf-8' }));
  app.get('/static/app.js', (c) => c.body(js, 200, { 'Content-Type': 'text/javascript; charset=utf-8' }));
  registerBoard(app, deps);
  registerGraph(app, deps);
  registerSettings(app, deps);
  registerAccounts(app, deps);
  registerReview(app);
  const built = new Set(app.routes.map((r) => `${r.method} ${r.path}`));
  for (const route of routes)
    if (!built.has(`${route.method} ${route.path}`))
      app.on(route.method, route.path, (c) =>
        c.html(
          shell(
            'Capability unavailable',
            html`${pageHeading('Capability unavailable', 'This action is deferred in the current build.')}${unavailable('Chat withdrawal')}`,
            '/settings',
          ),
          422,
        ),
      );
  app.notFound((c) =>
    c.html(
      shell(
        'Page not found',
        html`<h1>Page not found</h1><p>This address does not have an active page.</p><a href="/board">Return to board</a>`,
      ),
      404,
    ),
  );
  return { routes, fetch: async (req) => app.fetch(req) };
}
