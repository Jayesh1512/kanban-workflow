import { createHmac, timingSafeEqual } from 'node:crypto';
import { html } from 'hono/html';
import type { Ctx } from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';
import { companyVersion, getCompany, resolveCompany } from '../graph/index.ts';
import type { Markup, WebDeps } from './shared.ts';
import { hidden } from './shared.ts';

// A signed challenge binds the second POST to this actor, exact form, route and
// company catalogue. It prevents a forged confirmation bypassing the advisory.
export function confirmCompany(
  deps: WebDeps,
  ctx: Ctx,
  path: string,
  fields: Record<string, string>,
  choice?: string,
  challenge?: string,
): { name: string; page: Markup | null } {
  const name = fields.company ?? '';
  const match = name ? resolveCompany(ctx, name) : null;
  if (match?.match !== 'similar' || match.companyId === null) {
    if (challenge || choice)
      throw new AppError('conflict', 'Company matching changed. Submit the original form again.');
    return { name, page: null };
  }
  const candidate = getCompany(ctx, match.companyId);
  const payload = (expires: string) =>
    JSON.stringify([
      ctx.actor,
      path,
      Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)),
      match.companyId,
      companyVersion(ctx.db),
      expires,
    ]);
  const sign = (expires: string) => createHmac('sha256', deps.config.secretKey).update(payload(expires)).digest('hex');
  if (choice !== undefined || challenge !== undefined) {
    const [expires, signature, extra] = (challenge ?? '').split('.');
    if (
      !expires ||
      !signature ||
      extra !== undefined ||
      !/^\d+$/.test(expires) ||
      !/^[a-f0-9]{64}$/.test(signature) ||
      Number(expires) < deps.now().getTime() ||
      Number(expires) > deps.now().getTime() + 600000 ||
      !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(sign(expires), 'hex'))
    )
      throw new AppError('invalid', 'Company confirmation is invalid or expired. Submit the original form again.');
    if (choice !== 'candidate' && choice !== 'separate')
      throw new AppError('invalid', 'Choose the existing company or confirm a separate company.');
    return { name: choice === 'candidate' ? candidate.name : name, page: null };
  }
  const expires = String(deps.now().getTime() + 600000);
  return {
    name,
    page: html`<main class="form-section"><h1>Confirm the company</h1><p>You entered <strong>${name}</strong>. It is similar to the existing company <a href="/companies/${candidate.id}">${candidate.name}</a>.</p><p>Choose the existing record, or explicitly create a separate company. This does not merge companies or create an alias.</p><form method="post" action="${path}">${Object.entries(fields).map(([key, value]) => hidden(key, value))}${hidden('challenge', `${expires}.${sign(expires)}`)}<fieldset><legend>Company choice</legend><label class="check"><input type="radio" name="choice" value="candidate" required>Use ${candidate.name}</label><label class="check"><input type="radio" name="choice" value="separate" required>Create ${name} as a separate company</label></fieldset><button>Confirm company and continue</button></form></main>`,
  };
}
