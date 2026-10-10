import type {
  CompanyCandidate,
  CompanyMatch,
  CompanyRef,
  CompanyView,
  ContactSummary,
  ContactView,
  Ctx,
  Db,
  Id,
  KnownCompanyPanel,
  WriteOpts,
} from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';
export function normalizeCompanyName(name: string): string {
  void name;
  throw new AppError('invalid', 'not built: normalizeCompanyName');
}

export function resolveCompany(ctx: Ctx, name: string): CompanyMatch {
  void ctx;
  void name;
  throw new AppError('invalid', 'not built: resolveCompany');
}

export function candidateCompanies(ctx: Ctx, i: { chatId: Id; text: string; cardIds: Id[] }): CompanyCandidate[] {
  void ctx;
  void i;
  throw new AppError('invalid', 'not built: candidateCompanies');
}

export function companyVersion(db: Db): number {
  void db;
  throw new AppError('invalid', 'not built: companyVersion');
}

export function ensureCompany(ctx: Ctx, name: string): Id {
  void ctx;
  void name;
  throw new AppError('invalid', 'not built: ensureCompany');
}

export function ensureIdentity(
  ctx: Ctx,
  p: { channel: string; userKey: string; displayName: string; handle: string | null },
): { identityId: Id; contactId: Id | null; teammateId: Id | null } {
  void ctx;
  void p;
  throw new AppError('invalid', 'not built: ensureIdentity');
}

export function bindSelfIdentity(
  ctx: Ctx,
  p: { channel: string; userKey: string; displayName: string; handle: string | null; teammateId: Id },
): Id {
  void ctx;
  void p;
  throw new AppError('invalid', 'not built: bindSelfIdentity');
}

export function getContact(ctx: Ctx, contactId: Id): ContactView {
  void ctx;
  void contactId;
  throw new AppError('invalid', 'not built: getContact');
}

export function getCompany(ctx: Ctx, companyId: Id): CompanyView {
  void ctx;
  void companyId;
  throw new AppError('invalid', 'not built: getCompany');
}

export function searchContacts(
  ctx: Ctx,
  q: { companyId?: Id; roleCategory?: string; text?: string; limit?: number; offset?: number },
): ContactSummary[] {
  void ctx;
  void q;
  throw new AppError('invalid', 'not built: searchContacts');
}

export function searchCompanies(
  ctx: Ctx,
  q: { text?: string; limit?: number },
): { id: Id; name: string; contactCount: number }[] {
  void ctx;
  void q;
  throw new AppError('invalid', 'not built: searchCompanies');
}

export function updateContact(ctx: Ctx, contactId: Id, i: { displayName: string }): void {
  void ctx;
  void contactId;
  void i;
  throw new AppError('invalid', 'not built: updateContact');
}

export function setContactCompany(
  ctx: Ctx,
  contactId: Id,
  i: { company: CompanyRef; evidenceMessageIds: Id[] },
  o?: WriteOpts,
): void {
  void ctx;
  void contactId;
  void i;
  void o;
  throw new AppError('invalid', 'not built: setContactCompany');
}

export function removeContactCompany(ctx: Ctx, contactId: Id, companyId: Id): void {
  void ctx;
  void contactId;
  void companyId;
  throw new AppError('invalid', 'not built: removeContactCompany');
}

export function setContactRole(
  ctx: Ctx,
  contactId: Id,
  i: { category: string; dealsAbout: string; evidenceMessageIds: Id[] },
  o?: WriteOpts,
): void {
  void ctx;
  void contactId;
  void i;
  void o;
  throw new AppError('invalid', 'not built: setContactRole');
}

export function recordReference(
  ctx: Ctx,
  i: { fromCompanyId: Id | null; toCompanyId: Id; messageId: Id; cardId: Id | null },
  o?: WriteOpts,
): Id | null {
  void ctx;
  void i;
  void o;
  throw new AppError('invalid', 'not built: recordReference');
}

export function removeReference(ctx: Ctx, referenceId: Id): void {
  void ctx;
  void referenceId;
  throw new AppError('invalid', 'not built: removeReference');
}

export function renameCompany(ctx: Ctx, companyId: Id, name: string): void {
  void ctx;
  void companyId;
  void name;
  throw new AppError('invalid', 'not built: renameCompany');
}

export function addCompanyAlias(ctx: Ctx, companyId: Id, alias: string): void {
  void ctx;
  void companyId;
  void alias;
  throw new AppError('invalid', 'not built: addCompanyAlias');
}

export function markNotSame(ctx: Ctx, name: string, companyId: Id): void {
  void ctx;
  void name;
  void companyId;
  throw new AppError('invalid', 'not built: markNotSame');
}

export function cardReferencePanels(ctx: Ctx, cardId: Id): KnownCompanyPanel[] {
  void ctx;
  void cardId;
  throw new AppError('invalid', 'not built: cardReferencePanels');
}
export type * from '../contracts/index.ts';
export { forgetMessages } from './forget.ts';
