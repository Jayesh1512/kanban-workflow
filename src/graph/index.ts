export type * from '../contracts/index.ts';
export { addCompanyAlias, ensureCompany, markNotSame, renameCompany } from './companies.ts';
export { removeContactCompany, setContactCompany, setContactRole, updateContact } from './contacts.ts';
export { forgetMessages } from './forget.ts';
export { bindSelfIdentity, ensureIdentity } from './identities.ts';
export { candidateCompanies, companyVersion, normalizeCompanyName, resolveCompany } from './matching.ts';
export { recordReference, removeReference } from './references.ts';
export { cardReferencePanels, getCompany, getContact, searchCompanies, searchContacts } from './views.ts';
