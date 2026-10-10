import { z } from 'zod';
import type { Ctx, Id } from '../contracts/index.ts';
import { AppError, IdSchema } from '../contracts/index.ts';
import { record } from '../log/index.ts';
import { by, human, validate } from './helpers.ts';
import { normalizeCompanyName, resolveCompany } from './matching.ts';

function normalized(name: string): string {
  validate(z.string().trim().min(1), name);
  const norm = normalizeCompanyName(name);
  if (!norm) throw new AppError('invalid', 'Company name is empty');
  return norm;
}
function company(ctx: Ctx, id: Id): { id: Id; name: string } {
  validate(IdSchema, id);
  const c = ctx.db.get<{ id: Id; name: string }>('SELECT id,name FROM company WHERE id=?', id);
  if (!c) throw new AppError('not_found', 'Company not found');
  return c;
}
function ensure(ctx: Ctx, name: string): Id {
  by(ctx);
  const norm = normalized(name);
  return ctx.db.tx(() => {
    const match = resolveCompany(ctx, name);
    if ((match.match === 'exact' || match.match === 'alias') && match.companyId !== null) return match.companyId;
    if (ctx.actor.kind === 'agent' && match.match === 'similar')
      throw new AppError('conflict', 'Similar company needs human review');
    const id = ctx.db.run(
      'INSERT INTO company(name,name_norm,created_by_kind,created_at) VALUES (?,?,?,?)',
      name,
      norm,
      ctx.actor.kind,
      ctx.now().toISOString(),
    ).lastInsertRowid;
    record(ctx, { action: 'company.create', subjectKind: 'company', subjectId: id, after: { name } });
    return id;
  });
}
export function ensureCompany(ctx: Ctx, name: string): Id {
  // An agent creates a named company only while applying a validated participant
  // link, after participant/evidence/human-lock checks in setContactCompany.
  if (ctx.actor.kind === 'agent') throw new AppError('forbidden', 'Agent company creation requires participant link');
  return ensure(ctx, name);
}
export function ensureParticipantCompany(ctx: Ctx, name: string): Id {
  return ensure(ctx, name);
}

export function renameCompany(ctx: Ctx, companyId: Id, name: string): void {
  human(ctx);
  const norm = normalized(name);
  ctx.db.tx(() => {
    const before = company(ctx, companyId);
    const match = resolveCompany(ctx, name);
    if ((match.match === 'exact' || match.match === 'alias') && match.companyId !== companyId)
      throw new AppError('conflict', 'Company name belongs to another company');
    ctx.db.run('UPDATE company SET name=?,name_norm=? WHERE id=?', name, norm, companyId);
    record(ctx, {
      action: 'company.update',
      subjectKind: 'company',
      subjectId: companyId,
      before: { name: before.name },
      after: { name },
    });
  });
}
export function addCompanyAlias(ctx: Ctx, companyId: Id, alias: string): void {
  human(ctx);
  const norm = normalized(alias);
  ctx.db.tx(() => {
    company(ctx, companyId);
    const match = resolveCompany(ctx, alias);
    if ((match.match === 'exact' || match.match === 'alias') && match.companyId !== companyId)
      throw new AppError('conflict', 'Alias belongs to another company');
    if (ctx.db.get('SELECT alias_norm FROM company_alias WHERE alias_norm=? AND company_id=?', norm, companyId)) return;
    ctx.db.run('INSERT INTO company_alias(alias_norm,alias,company_id) VALUES (?,?,?)', norm, alias, companyId);
    record(ctx, { action: 'company.alias', subjectKind: 'company', subjectId: companyId, after: { alias } });
  });
}
export function markNotSame(ctx: Ctx, name: string, companyId: Id): void {
  human(ctx);
  const norm = normalized(name);
  ctx.db.tx(() => {
    company(ctx, companyId);
    if (
      ctx.db.run('INSERT OR IGNORE INTO company_not_same(name_norm,company_id) VALUES (?,?)', norm, companyId).changes
    )
      record(ctx, {
        action: 'company.not_same',
        subjectKind: 'company',
        subjectId: companyId,
        after: { nameNorm: norm },
      });
  });
}
