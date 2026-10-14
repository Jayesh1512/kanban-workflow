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
  const nav = [
    ['/board', 'Board'],
    ['/review', 'Review'],
    ['/companies', 'Companies'],
    ['/contacts', 'Contacts'],
    ['/lanes', 'Lanes'],
    ['/log', 'Activity'],
    ['/settings', 'Settings'],
  ];
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Team board</title><link rel="stylesheet" href="/static/app.css"><script src="/static/app.js" defer></script></head><body>
    <a class="skip-link" href="#content">Skip to content</a>
    ${signedIn ? html`<div class="app-bar"><a class="app-name" href="/board">Team board</a><nav aria-label="Main">${nav.map(([path, label]) => html`<a href="${path}" aria-current="${active === path ? 'page' : 'false'}">${label}</a>`)}</nav><form class="quick-search" action="/search" method="get"><label class="sr-only" for="quick-q">Search messages</label><input id="quick-q" name="q" placeholder="Search messages" required></form><form action="/logout" method="post"><button class="quiet">Sign out</button></form></div>` : ''}
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
