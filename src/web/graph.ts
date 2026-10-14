import { html } from 'hono/html';
import { z } from 'zod';
import { getSetting } from '../auth/index.ts';
import { searchCards } from '../board/index.ts';
import { SubjectKindSchema } from '../contracts/index.ts';
import {
  addCompanyAlias,
  getCompany,
  getContact,
  removeContactCompany,
  removeReference,
  renameCompany,
  searchCompanies,
  searchContacts,
  setContactCompany,
  setContactRole,
  updateContact,
} from '../graph/index.ts';
import { searchMessages } from '../ingest/index.ts';
import { history } from '../log/index.ts';
import { confirmCompany } from './company-confirmation.ts';
import { cardsList, logEntries, messages, references } from './render.ts';
import {
  empty,
  evidenceField,
  form,
  formId,
  hidden,
  id,
  optionalId,
  pageHeading,
  parse,
  shell,
  textField,
  time,
} from './shared.ts';

const subjectKinds = [
  'lane',
  'card',
  'message',
  'contact',
  'company',
  'reference',
  'review',
  'setting',
  'teammate',
  'credential',
  'account',
  'chat',
  'mcp',
] as const;

import type { WebApp, WebDeps } from './shared.ts';

export function registerGraph(app: WebApp, deps: WebDeps): void {
  app.get('/companies', (c) => {
    const q = parse(z.strictObject({ q: z.string().max(2000).optional() }), c.req.query());
    const companies = searchCompanies(c.get('ctx'), { text: q.q, limit: Number.MAX_SAFE_INTEGER });
    return c.html(
      shell(
        'Companies',
        html`${pageHeading('Companies', 'Context across your teammates’ conversations.')}<main><form method="get" class="filter-form"><label>Company name or alias<input name="q" value="${q.q ?? ''}"></label><button>Find companies</button></form><ul class="entity-list">${companies.length ? companies.map((co) => html`<li><a href="/companies/${co.id}">${co.name}</a><span>${co.contactCount} contacts</span></li>`) : html`<li class="empty">No matching companies.</li>`}</ul></main>`,
        '/companies',
      ),
    );
  });
  app.get('/companies/:id', (c) => {
    const co = getCompany(c.get('ctx'), id(c));
    return c.html(
      shell(
        co.name,
        html`${pageHeading(co.name, 'Company context across the team')}<main class="detail-layout"><div><section><h2>Contacts & roles</h2><ul class="entity-list">${co.contacts.length ? co.contacts.map((p) => html`<li><a href="/contacts/${p.id}">${p.name}</a><span>${p.roleCategory} · ${p.dealsAbout || 'No role detail'}</span></li>`) : html`<li class="empty">No linked contacts.</li>`}</ul></section><section><h2>Conversations</h2><p>Last conversation: ${time(co.lastConversationAt)}</p><ul class="entity-list">${co.chats.map((ch) => html`<li><span>${ch.title}</span><span>${ch.teammates.map((t) => t.name).join(', ') || 'No contributing teammate'} · ${time(ch.lastMessageAt)}</span></li>`)}</ul></section><section><h2>Recent messages</h2>${messages(co.recentMessages, searchCards(c.get('ctx'), { limit: Number.MAX_SAFE_INTEGER }).cards)}</section><section><h2>Cards</h2>${cardsList(co.cards)}</section><section><h2>References to other companies</h2>${references(co.referencesOut)}</section><section><h2>Referenced by</h2>${co.referencedBy.length ? co.referencedBy.map((r) => html`<div class="reference"><p>${r.company ? html`<a href="/companies/${r.company.id}">${r.company.name}</a>` : 'Company unknown'}</p>${messages([r.message])}<form method="post" action="/references/${r.referenceId}/remove">${hidden('companyId', co.id)}<button class="quiet">Remove reference</button></form></div>`) : empty('No incoming references.')}</section></div><aside class="detail-sidebar"><section><h2>Company name</h2><form method="post" action="/companies/${co.id}"><label>Name<input name="name" value="${co.name}" required></label><button>Save name</button></form></section><section><h2>Aliases</h2>${co.aliases.length ? html`<ul>${co.aliases.map((a) => html`<li>${a}</li>`)}</ul>` : empty('No recorded aliases.')}<form method="post" action="/companies/${co.id}/aliases"><label>Exact alternative name<input name="alias" required></label><button>Add alias</button></form><p class="muted">An alias affects matching. Company merging is unavailable.</p></section></aside></main>`,
        '/companies',
      ),
    );
  });
  app.post('/companies/:id', async (c) => {
    const p = parse(z.strictObject({ name: textField }), await form(c));
    const co = id(c);
    renameCompany(c.get('ctx'), co, p.name);
    return c.redirect(`/companies/${co}`, 303);
  });
  app.post('/companies/:id/aliases', async (c) => {
    const p = parse(z.strictObject({ alias: textField }), await form(c));
    const co = id(c);
    addCompanyAlias(c.get('ctx'), co, p.alias);
    return c.redirect(`/companies/${co}`, 303);
  });
  app.get('/contacts', (c) => {
    const ctx = c.get('ctx');
    const q = parse(
      z.strictObject({
        q: z.string().max(2000).optional(),
        companyId: optionalId.optional(),
        roleCategory: z.string().max(200).optional(),
      }),
      c.req.query(),
    );
    const contacts = searchContacts(ctx, {
      text: q.q,
      companyId: q.companyId ?? undefined,
      roleCategory: q.roleCategory || undefined,
      limit: Number.MAX_SAFE_INTEGER,
    });
    return c.html(
      shell(
        'Contacts',
        html`${pageHeading('Contacts', 'Find people by company, role and conversation context.')}<main><form method="get" class="filter-form"><label>Name or role detail<input name="q" value="${q.q ?? ''}"></label><label>Company<select name="companyId"><option value="">All companies</option>${searchCompanies(ctx, { limit: Number.MAX_SAFE_INTEGER }).map((co) => html`<option value="${co.id}" ${q.companyId === co.id ? html`selected` : ''}>${co.name}</option>`)}</select></label><label>Role<select name="roleCategory"><option value="">All roles</option>${getSetting<string[]>(ctx.db, 'role_categories').map((r) => html`<option ${q.roleCategory === r ? html`selected` : ''}>${r}</option>`)}</select></label><button>Find contacts</button></form><ul class="entity-list">${contacts.length ? contacts.map((p) => html`<li><a href="/contacts/${p.id}">${p.name}</a><span>${p.companies.map((co) => co.name).join(', ') || 'Company unknown'} · ${p.roleCategory} · ${p.dealsAbout || 'No role detail'}</span></li>`) : html`<li class="empty">No matching contacts.</li>`}</ul></main>`,
        '/contacts',
      ),
    );
  });
  app.get('/contacts/:id', (c) => {
    const ctx = c.get('ctx');
    const p = getContact(ctx, id(c));
    return c.html(
      shell(
        p.name,
        html`${pageHeading(p.name, `${p.roleCategory} · ${p.dealsAbout || 'No role detail'}`)}<main class="detail-layout"><div><section><h2>Companies</h2><ul class="entity-list">${p.companies.map((co) => html`<li><a href="/companies/${co.id}">${co.name}</a><form method="post" action="/contacts/${p.id}/companies/${co.id}/remove"><button class="quiet">Remove link</button></form></li>`)}</ul>${p.companies.length ? '' : empty('Company unknown.')}${p.companyEvidence.map((e) => html`<h3>Evidence for company <a href="/companies/${e.companyId}">${e.companyId}</a></h3>${messages(e.messages)}`)}</section><section><h2>Role evidence</h2>${messages(p.roleEvidence)}</section><section><h2>Identities</h2><ul>${p.identities.map((i) => html`<li>${i.displayName}${i.handle ? ` · ${i.handle}` : ''}</li>`)}</ul></section><section><h2>Conversations</h2><p>Last conversation: ${time(p.lastConversationAt)}</p><ul>${p.chats.map((ch) => html`<li>${ch.title} · ${time(ch.lastMessageAt)}</li>`)}</ul></section><section><h2>Recent messages</h2>${messages(p.recentMessages, searchCards(ctx, { limit: Number.MAX_SAFE_INTEGER }).cards)}</section><section><h2>Cards</h2>${cardsList(p.cards)}</section></div><aside class="detail-sidebar"><section><h2>Correct name</h2><form method="post" action="/contacts/${p.id}"><label>Name<input name="displayName" value="${p.name}" required></label><button>Save name</button></form></section><section><h2>Correct role</h2><form method="post" action="/contacts/${p.id}/role"><label>Category<select name="category">${getSetting<string[]>(ctx.db, 'role_categories').map((r) => html`<option ${r === p.roleCategory ? html`selected` : ''}>${r}</option>`)}</select></label><label>Deals about<textarea name="dealsAbout" rows="3">${p.dealsAbout}</textarea></label><label>Supporting message IDs<input name="evidenceMessageIds" value="${p.roleEvidence.map((m) => m.id).join(', ')}" placeholder="e.g. 12, 15"></label><p class="muted">A known role requires evidence from this contact's chats.</p><label>Reason<input name="reason" required></label><button>Save role</button></form></section><section><h2>Link company</h2><form method="post" action="/contacts/${p.id}/companies"><label>Company name<input name="company" required list="company-names"></label><datalist id="company-names">${searchCompanies(ctx, { limit: Number.MAX_SAFE_INTEGER }).map((co) => html`<option value="${co.name}"></option>`)}</datalist><label>Supporting message IDs<input name="evidenceMessageIds" placeholder="e.g. 12, 15"></label><label>Reason<input name="reason" required></label><p class="muted">Similar names require a separate confirmation before creating a company.</p><button>Link company</button></form></section></aside></main>`,
        '/contacts',
      ),
    );
  });
  app.post('/contacts/:id', async (c) => {
    const p = parse(z.strictObject({ displayName: textField }), await form(c));
    const contactId = id(c);
    updateContact(c.get('ctx'), contactId, p);
    return c.redirect(`/contacts/${contactId}`, 303);
  });
  app.post('/contacts/:id/role', async (c) => {
    const p = parse(
      z.strictObject({
        category: textField,
        dealsAbout: z.string().max(20000),
        evidenceMessageIds: evidenceField,
        reason: textField,
      }),
      await form(c),
    );
    const contactId = id(c);
    setContactRole(
      c.get('ctx'),
      contactId,
      { category: p.category, dealsAbout: p.dealsAbout, evidenceMessageIds: p.evidenceMessageIds },
      { reason: p.reason },
    );
    return c.redirect(`/contacts/${contactId}`, 303);
  });
  app.post('/contacts/:id/companies', async (c) => {
    const body = await form(c);
    const p = parse(
      z.strictObject({
        company: textField,
        evidenceMessageIds: evidenceField,
        reason: textField,
        choice: z.enum(['candidate', 'separate']).optional(),
        challenge: z.string().max(100).optional(),
      }),
      body,
    );
    const contactId = id(c);
    const ctx = c.get('ctx');
    getContact(ctx, contactId);
    const result = confirmCompany(
      deps,
      ctx,
      c.req.path,
      { company: p.company, evidenceMessageIds: body.evidenceMessageIds ?? '', reason: p.reason },
      p.choice,
      p.challenge,
    );
    if (result.page) return c.html(shell('Confirm company', result.page, '/contacts'));
    setContactCompany(
      ctx,
      contactId,
      { company: { name: result.name }, evidenceMessageIds: p.evidenceMessageIds },
      { reason: p.reason },
    );
    return c.redirect(`/contacts/${contactId}`, 303);
  });
  app.post('/contacts/:id/companies/:companyId/remove', async (c) => {
    parse(z.strictObject({}), await form(c));
    const contactId = id(c);
    removeContactCompany(c.get('ctx'), contactId, id(c, 'companyId'));
    return c.redirect(`/contacts/${contactId}`, 303);
  });
  app.post('/references/:id/remove', async (c) => {
    const p = parse(z.strictObject({ companyId: formId }), await form(c));
    removeReference(c.get('ctx'), id(c));
    return c.redirect(`/companies/${p.companyId}`, 303);
  });
  app.get('/search', (c) => {
    const q = parse(z.strictObject({ q: z.string().max(2000).optional() }), c.req.query());
    const ctx = c.get('ctx');
    const hits = q.q?.trim() ? searchMessages(ctx, { text: q.q, limit: 100 }) : [];
    return c.html(
      shell(
        'Search',
        html`${pageHeading('Search', 'Find stored messages and the work they support.')}<main><form method="get" class="filter-form"><label>Message text<input name="q" value="${q.q ?? ''}" required></label><button>Search</button></form>${q.q?.trim() ? html`<p>${hits.length} results (up to 100)</p>${hits.length ? hits.map((hit) => html`<section class="search-hit"><p>${hit.card ? html`<a href="/cards/${hit.card.id}">${hit.card.title}</a>` : 'No card attached'} · ${hit.companies.length ? hit.companies.map((co) => html`<a href="/companies/${co.id}">${co.name}</a> `) : 'Company unknown'}</p>${messages([hit.message], searchCards(ctx, { limit: Number.MAX_SAFE_INTEGER }).cards)}</section>`) : empty('No stored messages match this text.')}` : empty('Enter text from a conversation to find its messages.')}<section><h2>Find cards, including archived work</h2>${q.q?.trim() ? cardsList(searchCards(ctx, { text: q.q, includeArchived: true, limit: 100 }).cards) : empty('Card results appear when you enter a search.')}</section></main>`,
      ),
    );
  });
  app.get('/log', (c) => {
    const q = parse(
      z.strictObject({
        subjectKind: z.union([z.literal('').transform(() => undefined), SubjectKindSchema]).optional(),
        subjectId: optionalId.optional(),
        beforeId: formId.optional(),
      }),
      c.req.query(),
    );
    const entries = history(c.get('ctx'), { ...q, subjectId: q.subjectId ?? undefined, limit: 100 });
    return c.html(
      shell(
        'Activity',
        html`${pageHeading('Activity', 'Who changed what, when, and why. Most recent first.')}<main><form method="get" class="filter-form"><label>Subject<select name="subjectKind"><option value="">All subjects</option>${subjectKinds.map((s) => html`<option ${s === q.subjectKind ? html`selected` : ''}>${s}</option>`)}</select></label><label>Subject ID<input name="subjectId" value="${q.subjectId ?? ''}" pattern="[1-9][0-9]*" inputmode="numeric"></label><button>Filter activity</button></form>${logEntries(entries)}${entries.length === 100 ? html`<a href="/log?beforeId=${entries.at(-1)?.id}${q.subjectKind ? `&subjectKind=${q.subjectKind}` : ''}${q.subjectId ? `&subjectId=${q.subjectId}` : ''}">Older activity</a>` : ''}</main>`,
        '/log',
      ),
    );
  });
}
