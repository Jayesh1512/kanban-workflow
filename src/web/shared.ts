import type { Context, Hono } from 'hono';
import { html } from 'hono/html';
import { z } from 'zod';
import type { AppConfig, Ctx, Db, Host, Model, OpLog, Pipeline } from '../contracts/index.ts';
import { AppError, IdSchema } from '../contracts/index.ts';

export type WebEnv = { Variables: { ctx: Ctx } };
export type WebContext = Context<WebEnv>;
export type WebApp = Hono<WebEnv>;
export interface WebDeps {
  db: Db;
  now(): Date;
  host: Host;
  pipeline: Pipeline;
  model: Model;
  config: AppConfig;
  oplog: OpLog;
}
export type Markup = ReturnType<typeof html>;
export const textField = z.string().trim().min(1).max(2000);
export const formId = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(IdSchema);
export const optionalId = z.union([z.literal('').transform(() => null), formId]);
export const checkField = z
  .enum(['on'])
  .optional()
  .transform((v) => v === 'on');
export const evidenceField = z
  .string()
  .default('')
  .transform((s) => (s.trim() ? s.trim().split(/[\s,]+/) : []))
  .pipe(z.array(formId));

export function parse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  message = 'Invalid form. Check the fields and try again.',
): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('invalid', message);
  return result.data;
}
export function id(c: WebContext, name = 'id'): number {
  return parse(formId, c.req.param(name), 'Invalid identifier.');
}
export async function form(c: WebContext): Promise<Record<string, string>> {
  const params = new URLSearchParams(await c.req.text());
  const result: Record<string, string> = {};
  for (const [key, value] of params) {
    if (Object.hasOwn(result, key)) throw new AppError('invalid', 'A form field was repeated.');
    result[key] = value;
  }
  return result;
}
export function shell(title: string, content: Markup, active = '/board', signedIn = true): Markup {
  const primary = [
    ['/board', 'Pipeline'],
    ['/review', 'Review suggestions'],
    ['/settings/accounts', 'Connections'],
  ];
  const secondary = [
    ['/companies', 'Companies'],
    ['/contacts', 'Contacts'],
    ['/search', 'Search messages'],
    ['/log', 'Activity'],
    ['/lanes', 'Pipeline rules'],
    ['/settings', 'Settings & team'],
  ];
  const selected = (path: string) => active === path || (path !== '/settings' && active.startsWith(`${path}/`));
  const links = (items: string[][]) =>
    items.map(
      ([path = '', label]) => html`<a href="${path}" aria-current="${selected(path) ? 'page' : 'false'}">${label}</a>`,
    );
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Team board</title><link rel="stylesheet" href="/static/app.css"><script src="/static/app.js" defer></script></head><body>
    <a class="skip-link" href="#content">Skip to content</a>
    ${signedIn ? html`<header class="app-bar"><a class="app-name" href="/board">Team board</a><nav aria-label="Main">${links(primary)}</nav><details class="workspace-menu"><summary${secondary.some(([path = '']) => selected(path)) ? html` class="current"` : ''}>More</summary><div class="workspace-menu-content"><nav aria-label="More workspace tools">${links(secondary)}</nav><form class="quick-search" action="/search" method="get"><label for="quick-q">Search messages</label><input id="quick-q" name="q" type="search" placeholder="Words from a conversation" required><button class="secondary">Search</button></form><form action="/logout" method="post"><button class="quiet">Sign out</button></form></div></details></header>` : ''}
    <div id="content" class="workspace" tabindex="-1">${content}</div></body></html>`;
}
export function pageHeading(title: string, description: string, action: Markup | string = ''): Markup {
  return html`<div class="page-heading"><div><h1>${title}</h1><p class="muted">${description}</p></div>${action}</div>`;
}
export function empty(message: string): Markup {
  return html`<p class="empty">${message}</p>`;
}
export function time(at: string | null): Markup {
  if (at === null) return html`<span>Unknown</span>`;
  return html`<time datetime="${at}" title="${at}">${at.slice(0, 10)} ${at.slice(11, 16)} UTC</time>`;
}
export function hidden(name: string, value: string | number): Markup {
  return html`<input type="hidden" name="${name}" value="${value}">`;
}
export function unavailable(name: string): Markup {
  return html`<section class="notice"><h2>${name} unavailable</h2><p>This capability is not built in the current backend. Your board, evidence and manual corrections remain available.</p><a href="/board">Return to board</a></section>`;
}
export function isNotBuilt(error: unknown, name: string): boolean {
  return error instanceof AppError && error.code === 'invalid' && error.message === `not built: ${name}`;
}
