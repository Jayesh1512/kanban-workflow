import assert from 'node:assert/strict';
import test from 'node:test';
import { createCard, createLane, getCard } from '../board/index.ts';
import { fixture } from '../board/test-fixture.ts';
import { AppError, CompanyViewSchema, ContactViewSchema, KnownCompanyPanelSchema } from '../contracts/index.ts';
import { searchMessages } from '../ingest/index.ts';
import { history } from '../log/index.ts';
import {
  addCompanyAlias,
  bindSelfIdentity,
  cardReferencePanels,
  companyVersion,
  ensureCompany,
  ensureIdentity,
  getCompany,
  getContact,
  markNotSame,
  recordReference,
  removeContactCompany,
  removeReference,
  renameCompany,
  searchCompanies,
  searchContacts,
  setContactCompany,
  setContactRole,
  updateContact,
} from './index.ts';

const code = (c: AppError['code']) => (e: unknown) => e instanceof AppError && e.code === c;
const laneInput = {
  name: 'Work',
  sop: 'Project work',
  stages: [
    { name: 'New', criteria: '' },
    { name: 'Done', criteria: 'Complete' },
  ],
};

test('R18.6/8 direct identity/name/multiplecompany correction and human named-company protection', async (t) => {
  const f = await fixture(t);
  assert.equal(
    ensureIdentity(f.agent, { channel: 'fixture', userKey: 'client', displayName: 'Changed', handle: null }).contactId,
    f.contactId,
  );
  assert.equal(getContact(f.ctx, f.contactId).name, 'Changed');
  updateContact(f.ctx, f.contactId, { displayName: 'Human name' });
  ensureIdentity(f.agent, { channel: 'fixture', userKey: 'client', displayName: 'Latest channel name', handle: 'new' });
  assert.equal(getContact(f.ctx, f.contactId).name, 'Human name');
  const m = f.message(f.chatId);
  setContactCompany(f.agent, f.contactId, { company: { name: 'Acme' }, evidenceMessageIds: [m] });
  const acme = getContact(f.ctx, f.contactId).companies[0]?.id;
  assert.ok(acme);
  removeContactCompany(f.ctx, f.contactId, acme);
  assert.equal(getContact(f.ctx, f.contactId).companies.length, 0);
  assert.throws(
    () => setContactCompany(f.agent, f.contactId, { company: { id: acme }, evidenceMessageIds: [m] }),
    code('forbidden'),
  );
  setContactCompany(f.ctx, f.contactId, { company: { id: acme }, evidenceMessageIds: [] }, { setBy: 'human' });
  const other = ensureCompany(f.ctx, 'Other');
  setContactCompany(f.ctx, f.contactId, { company: { id: other }, evidenceMessageIds: [m] });
  assert.equal(getContact(f.ctx, f.contactId).companies.length, 2);
  const count = searchCompanies(f.ctx, {}).length;
  assert.throws(
    () =>
      setContactCompany(f.agent, f.contactId, { company: { name: 'Sneaky new employer' }, evidenceMessageIds: [m] }),
    code('forbidden'),
  );
  assert.equal(searchCompanies(f.ctx, {}).length, count);
  assert.throws(() => ensureCompany(f.agent, 'Arbitrary new company'), code('forbidden'));
  assert.equal(searchContacts(f.ctx, { companyId: other, text: 'human' })[0]?.id, f.contactId);
  assert.equal(
    history(f.ctx, { action: 'contact.update' }).find(
      (e) => e.actor.kind === 'teammate' && (e.after as { displayName?: string })?.displayName === 'Human name',
    )?.actor.name,
    'alice',
  );
});

test('R18 identity binds previously outside self and retires contact without changing stored message sender', async (t) => {
  const f = await fixture(t);
  const self = ensureIdentity(f.agent, { channel: 'fixture', userKey: 'was-self', displayName: 'Self', handle: null });
  assert.ok(self.contactId);
  const chat = f.chat('self', 0, self.identityId),
    m = f.message(chat, 'Outbound', self.identityId);
  const alice = f.ctx.actor.kind === 'teammate' ? f.ctx.actor.id : 0;
  assert.equal(
    bindSelfIdentity(f.ctx, {
      channel: 'fixture',
      userKey: 'was-self',
      displayName: 'Alice',
      handle: 'alice',
      teammateId: alice,
    }),
    self.identityId,
  );
  assert.equal(f.h.db.get('SELECT id FROM contact WHERE id=?', self.contactId), undefined);
  assert.equal(
    f.h.db.get<{ sender_identity_id: number }>('SELECT sender_identity_id FROM message WHERE id=?', m)
      ?.sender_identity_id,
    self.identityId,
  );
  assert.equal(history(f.ctx, { action: 'contact.retire' })[0]?.subjectId, self.contactId);
  const bob = f.h.ctxFor('bob').actor;
  assert.throws(
    () =>
      bindSelfIdentity(f.ctx, {
        channel: 'fixture',
        userKey: 'was-self',
        displayName: 'Bob',
        handle: null,
        teammateId: bob.kind === 'teammate' ? bob.id : 0,
      }),
    code('conflict'),
  );
  assert.equal(
    ensureIdentity(f.agent, { channel: 'fixture', userKey: 'was-self', displayName: 'Alice', handle: null }).contactId,
    null,
  );
});

test('R19.4/5 direct roles require stored contact-chat evidence, keep human value and log before/after', async (t) => {
  const f = await fixture(t),
    m = f.message(f.chatId),
    other = f.chat('unrelated', 0, null),
    foreign = f.message(other);
  assert.throws(
    () => setContactRole(f.agent, f.contactId, { category: 'finance', dealsAbout: 'Invoices', evidenceMessageIds: [] }),
    code('invalid'),
  );
  assert.throws(
    () =>
      setContactRole(f.agent, f.contactId, { category: 'invented', dealsAbout: 'Invoices', evidenceMessageIds: [m] }),
    code('invalid'),
  );
  assert.throws(
    () =>
      setContactRole(f.agent, f.contactId, {
        category: 'finance',
        dealsAbout: 'Invoices',
        evidenceMessageIds: [foreign],
      }),
    code('invalid'),
  );
  setContactRole(f.agent, f.contactId, { category: 'finance', dealsAbout: 'Invoices', evidenceMessageIds: [m, m] });
  setContactRole(f.agent, f.contactId, { category: 'technical', dealsAbout: 'Systems', evidenceMessageIds: [m] });
  const log = history(f.ctx, { action: 'contact.set_role' })[0];
  assert.ok(log);
  assert.equal((log.before as { category: string }).category, 'finance');
  assert.equal((log.after as { category: string }).category, 'technical');
  assert.deepEqual(
    getContact(f.ctx, f.contactId).roleEvidence.map((e) => e.id),
    [m],
  );
  setContactRole(f.ctx, f.contactId, { category: 'unknown', dealsAbout: '', evidenceMessageIds: [] });
  assert.equal(getContact(f.ctx, f.contactId).roleCategory, 'unknown');
  assert.equal(getContact(f.ctx, f.contactId).roleEvidence.length, 0);
  setContactRole(f.ctx, f.contactId, { category: 'finance', dealsAbout: 'Human corrected', evidenceMessageIds: [m] });
  assert.throws(
    () => setContactRole(f.agent, f.contactId, { category: 'technical', dealsAbout: 'Undo', evidenceMessageIds: [m] }),
    code('forbidden'),
  );
  assert.equal(searchContacts(f.ctx, { roleCategory: 'finance' })[0]?.id, f.contactId);
  assert.equal(searchContacts(f.ctx, { roleCategory: 'technical' }).length, 0);
  assert.ok(getContact({ ...f.ctx, canReadText: false }, f.contactId).roleEvidence.every((m) => m.text === null));
});

test('R21.3/4 direct reference panels use nonrecursive CardSummary and M1 messages on both companies; removed reference memory', async (t) => {
  const f = await fixture(t),
    lane = createLane(f.ctx, laneInput);
  const a = ensureCompany(f.ctx, 'Acme'),
    b = ensureCompany(f.ctx, 'Globex');
  const m = f.message(f.chatId, 'Please talk to Globex'),
    n = f.message(f.otherChatId, 'Globex work');
  setContactCompany(f.ctx, f.contactId, { company: { id: a }, evidenceMessageIds: [m] });
  setContactCompany(f.ctx, f.contactId, { company: { id: b }, evidenceMessageIds: [n] });
  const ca = createCard(f.agent, { laneId: lane.id, title: 'Acme card', companyId: a, messageId: m });
  const cb = createCard(f.agent, { laneId: lane.id, title: 'Globex card', companyId: b, messageId: n });
  const ref = recordReference(f.agent, { fromCompanyId: a, toCompanyId: b, messageId: m, cardId: ca.id });
  assert.ok(ref);
  assert.equal(recordReference(f.agent, { fromCompanyId: a, toCompanyId: b, messageId: m, cardId: ca.id }), ref);
  const panel = cardReferencePanels(f.ctx, ca.id)[0];
  assert.ok(panel);
  KnownCompanyPanelSchema.parse(panel);
  assert.equal(panel.company.id, b);
  assert.deepEqual(
    panel.openCards.map((c) => c.id),
    [cb.id],
  );
  assert.ok(!('messages' in (panel.openCards[0] ?? {})));
  assert.equal(getCard(f.ctx, ca.id).references[0]?.message.text, 'Please talk to Globex');
  const company = getCompany(f.ctx, a);
  CompanyViewSchema.parse(company);
  assert.equal(company.referencesOut[0]?.referenceId, ref);
  assert.equal(getCompany(f.ctx, b).referencedBy[0]?.company?.id, a);
  assert.equal(getCompany(f.ctx, b).referencedBy[0]?.message.id, m);
  const contact = getContact(f.ctx, f.contactId);
  ContactViewSchema.parse(contact);
  assert.deepEqual(contact.cards.map((c) => c.id).sort(), [ca.id, cb.id]);
  assert.deepEqual(
    contact.chats.map((c) => c.title),
    ['Chat one', 'Chat two'],
  );
  assert.equal(searchMessages(f.ctx, { text: 'Please talk' })[0]?.card?.id, ca.id);
  const noText = { ...f.ctx, canReadText: false };
  assert.equal(getCard(noText, ca.id).references[0]?.message.text, null);
  assert.equal(getCompany(noText, a).referencesOut[0]?.message.text, null);
  assert.equal(getCompany(noText, b).referencedBy[0]?.message.text, null);
  assert.ok(
    getContact(noText, f.contactId)
      .companyEvidence.flatMap((e) => e.messages)
      .every((m) => m.text === null),
  );
  removeReference(f.ctx, ref);
  assert.equal(recordReference(f.agent, { fromCompanyId: a, toCompanyId: b, messageId: m, cardId: ca.id }), null);
  assert.equal(getCompany(f.ctx, a).referencesOut.length, 0);
  assert.equal(getCompany(f.ctx, b).referencedBy.length, 0);
});

test('R20 small company/contact recent readers are newest50 across teammates, aliases and search filters', async (t) => {
  const f = await fixture(t),
    company = ensureCompany(f.ctx, 'Acme');
  setContactCompany(f.ctx, f.contactId, { company: { id: company }, evidenceMessageIds: [] });
  const ids = Array.from({ length: 60 }, (_, n) => f.message(n % 2 ? f.chatId : f.otherChatId, `Read ${n}`));
  const view = getCompany(f.ctx, company);
  assert.deepEqual(
    view.recentMessages.map((m) => m.id),
    ids.slice(-50).reverse(),
  );
  assert.deepEqual(
    getContact(f.ctx, f.contactId).recentMessages.map((m) => m.id),
    ids.slice(-50).reverse(),
  );
  assert.deepEqual(
    view.chats.flatMap((c) => c.teammates.map((t) => t.name)),
    ['alice', 'bob'],
  );
  const before = companyVersion(f.h.db);
  addCompanyAlias(f.ctx, company, 'AC');
  assert.ok(companyVersion(f.h.db) > before);
  assert.equal(searchCompanies(f.ctx, { text: 'AC' })[0]?.contactCount, 1);
  renameCompany(f.ctx, company, 'Acme New');
  assert.equal(searchCompanies(f.ctx, { text: 'new' })[0]?.id, company);
});

test('graph human-only actor enumeration and evidence/company/reference rollback preserve atomicity', async (t) => {
  const f = await fixture(t),
    m = f.message(f.chatId),
    company = ensureCompany(f.ctx, 'Acme');
  for (const fn of [
    () => updateContact(f.agent, f.contactId, { displayName: 'Bad' }),
    () => removeContactCompany(f.agent, f.contactId, company),
    () => removeReference(f.agent, 1),
    () => renameCompany(f.agent, company, 'Bad'),
    () => addCompanyAlias(f.agent, company, 'Bad'),
    () => markNotSame(f.agent, 'Bad', company),
  ])
    assert.throws(fn, code('forbidden'));
  f.h.db.run(
    "CREATE TRIGGER fail_graph BEFORE INSERT ON action_log WHEN NEW.action='contact.set_company' BEGIN SELECT RAISE(ABORT,'log failure'); END",
  );
  const version = companyVersion(f.h.db);
  assert.throws(
    () => setContactCompany(f.agent, f.contactId, { company: { name: 'New company' }, evidenceMessageIds: [m] }),
    /log failure/,
  );
  assert.equal(companyVersion(f.h.db), version);
  assert.equal(searchCompanies(f.ctx, { text: 'New company' }).length, 0);
  assert.equal(getContact(f.ctx, f.contactId).companyEvidence.length, 0);
  f.h.db.run('DROP TRIGGER fail_graph');
  f.h.db.run(
    "CREATE TRIGGER fail_role BEFORE INSERT ON action_log WHEN NEW.action='contact.set_role' BEGIN SELECT RAISE(ABORT,'log failure'); END",
  );
  assert.throws(
    () =>
      setContactRole(f.agent, f.contactId, { category: 'technical', dealsAbout: 'Failed', evidenceMessageIds: [m] }),
    /log failure/,
  );
  assert.equal(getContact(f.ctx, f.contactId).roleCategory, 'unknown');
  assert.equal(getContact(f.ctx, f.contactId).roleEvidence.length, 0);
});
