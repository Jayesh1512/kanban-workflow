import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { html } from 'hono/html';
import { z } from 'zod';
import { acceptReview } from '../agent/index.ts';
import { getSetting, signIn, teammateForSession } from '../auth/index.ts';
import { getBoard } from '../board/index.ts';
import type { AppConfig, Ctx, Db, Host, Model, OpLog, Pipeline } from '../contracts/index.ts';
import { AppError, IdSchema } from '../contracts/index.ts';
import { routeInventory } from './routes.ts';

export function createWeb(deps: {
  db: Db;
  now(): Date;
  host: Host;
  pipeline: Pipeline;
  model: Model;
  config: AppConfig;
  oplog: OpLog;
}): { fetch(req: Request): Promise<Response>; routes: { method: string; path: string; public: boolean }[] } {
  const app = new Hono<{ Variables: { ctx: Ctx } }>();
  const routes = routeInventory();
  const css = readFileSync(new URL('./static/app.css', import.meta.url), 'utf8');
  const js = readFileSync(new URL('./static/app.js', import.meta.url), 'utf8');
  app.use('*', async (c, next) => {
    c.header('Content-Security-Policy', "default-src 'self'");
    if (c.req.method === 'POST' && c.req.header('Origin') !== deps.config.origin) return c.text('Origin refused', 403);
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
    if (error instanceof AppError) {
      const statuses = { unauthenticated: 401, forbidden: 403, not_found: 404, invalid: 422, conflict: 409 } as const;
      return c.text(error.message, statuses[error.code]);
    }
    deps.oplog('error', 'web.failed', { code: 'internal' });
    return c.text('Internal error', 500);
  });
  app.get('/login', (c) =>
    c.html(
      html`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in</title><link rel="stylesheet" href="/static/app.css"></head><body><main><h1>Sign in</h1><form method="post" action="/login"><label>Username <input name="username" autocomplete="username" required></label><label>Password <input name="password" type="password" autocomplete="current-password" required></label><button>Sign in</button></form></main></body></html>`,
    ),
  );
  app.post('/login', async (c) => {
    const body = Object.fromEntries(new URLSearchParams(await c.req.text()));
    const p = z.strictObject({ username: z.string().min(1), password: z.string().min(1) }).safeParse(body);
    if (!p.success) throw new AppError('invalid', 'Invalid login form');
    const session = signIn(deps.db, p.data.username, p.data.password, deps.now());
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
  app.get('/static/app.css', (c) => c.body(css, 200, { 'Content-Type': 'text/css; charset=utf-8' }));
  app.get('/static/app.js', (c) =>
    c.body(js, 200, {
      'Content-Type': 'text/javascript; charset=utf-8',
    }),
  );
  app.get('/board', (c) => {
    const ctx = c.get('ctx');
    const board = getBoard(ctx);
    const pipeline = deps.pipeline.status();
    const threshold = getSetting<number>(deps.db, 'review_threshold');
    const accounts =
      ctx.actor.kind === 'teammate'
        ? deps.db.all<{ id: number }>(
            'SELECT id FROM channel_account WHERE teammate_id=? AND state<>?',
            ctx.actor.id,
            'removed',
          )
        : [];
    const counts = accounts.length ? deps.host.chatCounts(ctx) : null;
    return c.html(html`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Team board</title><link rel="stylesheet" href="/static/app.css"></head><body>
      <header id="status" data-automatic-off="${Number(threshold >= 1)}" data-pipeline-state="${pipeline.state}" data-pipeline-reason="${pipeline.reason ?? ''}" data-open-review="${board.openReviewCount}" data-movement-state="${pipeline.movement.state}" data-movement-reason="${pipeline.movement.reason ?? ''}"><h1>Team board</h1><p>${threshold >= 1 ? 'Automatic actions are off. Decisions wait for review.' : 'Automatic actions above the review threshold are enabled.'}</p><p>${board.openReviewCount} open review items. Model: ${deps.model.name}. ${pipeline.reason ?? pipeline.state}</p></header>
      ${counts === null ? '' : html`<aside id="my-chats" data-connected="${Number(counts.connected)}" data-undecided="${counts.undecidedRecent ?? ''}" data-out-of-date="${counts.agreementOutOfDate}"><p>${counts.undecidedRecent === null ? 'Undecided chat count is unknown.' : `${counts.undecidedRecent} recent undecided chats.`}</p>${accounts.map((a) => html`<a href="/settings/accounts/${a.id}/chats">Your chats</a>`)}</aside>`}
      <main id="board" data-version="${board.version}">${board.lanes.map((l) => html`<section class="lane" data-lane-id="${l.id}" data-lane-name="${l.name}"><h2>${l.name}</h2>${l.stages.map((s) => html`<div class="stage" data-stage-id="${s.id}" data-stage-name="${s.name}"><h3>${s.name}</h3>${l.cards.filter((card) => card.stageId === s.id).map((card) => html`<article class="card" data-card-id="${card.id}" data-lane-id="${l.id}" data-stage-id="${s.id}" data-company-id="${card.company?.id ?? ''}" data-last-change-by="${card.lastChangeBy}" data-from-history="${Number(card.fromHistory)}" data-has-gap="${Number(card.hasGap)}"><h3 class="card-title">${card.title}</h3></article>`)}</div>`)}</section>`)}</main>
      </body></html>`);
  });
  app.post('/review/:id/accept', (c) => {
    const p = IdSchema.safeParse(Number(c.req.param('id')));
    if (!p.success) throw new AppError('invalid', 'Invalid review id');
    acceptReview(c.get('ctx'), p.data);
    return c.redirect('/board', 303);
  });
  const built = new Set([
    'GET /login',
    'POST /login',
    'GET /static/app.css',
    'GET /static/app.js',
    'GET /board',
    'POST /review/:id/accept',
  ]);
  for (const r of routes)
    if (!built.has(`${r.method} ${r.path}`))
      app.on(r.method, r.path, () => {
        throw new AppError('invalid', `not built: ${r.method} ${r.path}`);
      });
  return {
    routes,
    async fetch(req) {
      return app.fetch(req);
    },
  };
}
