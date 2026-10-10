import assert from 'node:assert/strict';
import test from 'node:test';
import { attachMessage, createCard, createLane, forgetMessages as forgetBoard } from '../board/index.ts';
import { fixture } from '../board/test-fixture.ts';
import type { Id } from '../contracts/index.ts';
import { deleteMessages } from '../ingest/index.ts';
import {
  addCompanyAlias,
  companyVersion,
  ensureCompany,
  ensureIdentity,
  forgetMessages,
  getContact,
  markNotSame,
  recordReference,
  setContactCompany,
  setContactRole,
} from './index.ts';

const laneInput = {
  name: 'Work',
  sop: 'Work',
  stages: [
    { name: 'New', criteria: '' },
    { name: 'Done', criteria: 'Done' },
  ],
};
function review(f: Awaited<ReturnType<typeof fixture>>, companyId: Id) {
  const at = f.h.clock.now().toISOString();
  f.h.db.run(
    "INSERT INTO review_item(kind,group_key,chat_id,proposal,why,confidence,reason,status,created_at,updated_at) VALUES ('contact_company',?, ?,?,'low_confidence',1,'Fixture','open',?,?)",
    `company:${companyId}`,
    f.otherChatId,
    JSON.stringify({ kind: 'contact_company', contactId: f.contactId, company: { id: companyId } }),
    at,
    at,
  );
}
function purgeCallbacks(f: Awaited<ReturnType<typeof fixture>>, ids: Id[]) {
  return f.h.db.tx(() => {
    f.h.db.run('PRAGMA defer_foreign_keys=ON');
    f.h.db.run('UPDATE chat SET withdrawn_at=? WHERE id=?', f.h.clock.now().toISOString(), f.chatId);
    forgetBoard(f.ctx, ids);
    const result = forgetMessages(f.ctx, { messageIds: ids, chatId: f.chatId });
    deleteMessages(f.ctx, ids);
    return result;
  });
}

test('R31 graph callback retires solechat contacts and resets only remaining agent values losing all evidence', async (t) => {
  const f = await fixture(t),
    doomed = f.message(f.chatId),
    retained = f.message(f.otherChatId);
  setContactCompany(f.agent, f.contactId, { company: { name: 'Agent ephemeral' }, evidenceMessageIds: [doomed] });
  const company = getContact(f.ctx, f.contactId).companies[0]?.id;
  assert.ok(company);
  setContactRole(f.agent, f.contactId, { category: 'technical', dealsAbout: 'Doomed', evidenceMessageIds: [doomed] });
  const sole = ensureIdentity(f.ctx, { channel: 'fixture', userKey: 'sole', displayName: 'Sole', handle: null });
  assert.ok(sole.contactId);
  f.h.db.run(
    'INSERT INTO chat_participant(chat_id,identity_id,first_seen_at) VALUES (?,?,?)',
    f.chatId,
    sole.identityId,
    f.h.clock.now().toISOString(),
  );
  const only = f.message(f.chatId, 'Sole', sole.identityId);
  const result = purgeCallbacks(f, [doomed, only]);
  assert.deepEqual(result, {
    removedContactIds: [sole.contactId],
    resetContactIds: [f.contactId],
    removedCompanyIds: [company],
  });
  assert.equal(getContact(f.ctx, f.contactId).roleCategory, 'unknown');
  assert.equal(getContact(f.ctx, f.contactId).dealsAbout, '');
  assert.equal(getContact(f.ctx, f.contactId).companies.length, 0);
  assert.equal(f.h.db.get('SELECT id FROM identity WHERE id=?', sole.identityId), undefined);
  assert.deepEqual(
    getContact(f.ctx, f.contactId).recentMessages.map((m) => m.id),
    [retained],
  );
  assert.deepEqual(f.h.db.all('PRAGMA foreign_key_check'), []);
});

test('R31 graph callback retains human fields and agent fields with remaining otherchat evidence', async (t) => {
  const f = await fixture(t),
    a = f.message(f.chatId),
    b = f.message(f.otherChatId);
  setContactCompany(f.agent, f.contactId, { company: { name: 'Shared evidence' }, evidenceMessageIds: [a, b] });
  const company = getContact(f.ctx, f.contactId).companies[0]?.id;
  assert.ok(company);
  setContactRole(f.ctx, f.contactId, { category: 'finance', dealsAbout: 'Human retained', evidenceMessageIds: [a] });
  const humanCompany = ensureCompany(f.ctx, 'Human company');
  setContactCompany(f.ctx, f.contactId, { company: { id: humanCompany }, evidenceMessageIds: [a] });
  const result = purgeCallbacks(f, [a]);
  assert.deepEqual(result, { removedContactIds: [], resetContactIds: [], removedCompanyIds: [] });
  const view = getContact(f.ctx, f.contactId);
  assert.equal(view.roleCategory, 'finance');
  assert.equal(view.dealsAbout, 'Human retained');
  assert.deepEqual(
    view.companies.map((c) => c.id),
    [company, humanCompany],
  );
  assert.deepEqual(
    view.companyEvidence.flatMap((e) => e.messages).map((m) => m.id),
    [b],
  );
});

test('R31 postpurge company retention: doomed own refs delete agent company; manual and preexisting companies survive', async (t) => {
  const f = await fixture(t),
    m = f.message(f.chatId);
  setContactCompany(f.agent, f.contactId, { company: { name: 'Only doomed reference' }, evidenceMessageIds: [m] });
  const doomedCompany = getContact(f.ctx, f.contactId).companies[0]?.id;
  assert.ok(doomedCompany);
  const manual = ensureCompany(f.ctx, 'Manually created'),
    older = ensureCompany(f.ctx, 'Earlier named');
  // Earlier than this chat's creation, and not an agent-created record.
  f.h.db.run('UPDATE company SET created_at=? WHERE id=?', '2026-08-01T00:00:00.000Z', older);
  f.h.db.run('UPDATE chat SET named_company_id=? WHERE id=?', older, f.chatId);
  recordReference(f.ctx, { fromCompanyId: manual, toCompanyId: doomedCompany, messageId: m, cardId: null });
  const result = purgeCallbacks(f, [m]);
  assert.deepEqual(result.removedCompanyIds, [doomedCompany]);
  assert.ok(f.h.db.get('SELECT id FROM company WHERE id=?', manual));
  assert.ok(f.h.db.get('SELECT id FROM company WHERE id=?', older));
  assert.equal(
    f.h.db.get<{ named_company_id: Id | null }>('SELECT named_company_id FROM chat WHERE id=?', f.chatId)
      ?.named_company_id,
    null,
  );
});

for (const survivor of ['card', 'reference', 'named', 'review', 'contact', 'evidence'] as const)
  test(`R31 agent-company survival by outsidechat ${survivor}`, async (t) => {
    const f = await fixture(t),
      a = f.message(f.chatId),
      b = f.message(f.otherChatId);
    setContactCompany(f.agent, f.contactId, { company: { name: 'Agent only' }, evidenceMessageIds: [a] });
    const company = getContact(f.ctx, f.contactId).companies[0]?.id;
    assert.ok(company);
    if (survivor === 'card') {
      const lane = createLane(f.ctx, laneInput),
        card = createCard(f.agent, { laneId: lane.id, title: 'Surviving', companyId: company, messageId: a });
      attachMessage(f.ctx, b, card.id);
    }
    if (survivor === 'reference')
      recordReference(f.ctx, { fromCompanyId: null, toCompanyId: company, messageId: b, cardId: null });
    if (survivor === 'named') f.h.db.run('UPDATE chat SET named_company_id=? WHERE id=?', company, f.otherChatId);
    if (survivor === 'review') review(f, company);
    if (survivor === 'contact')
      setContactCompany(f.ctx, f.contactId, { company: { id: company }, evidenceMessageIds: [a] });
    if (survivor === 'evidence')
      f.h.db.run(
        "INSERT INTO evidence(kind,contact_id,company_id,message_id) VALUES ('contact_company',?,?,?)",
        f.contactId,
        company,
        b,
      );
    assert.deepEqual(purgeCallbacks(f, [a]).removedCompanyIds, []);
    assert.ok(f.h.db.get('SELECT id FROM company WHERE id=?', company));
  });

test('R31 newly named inclusion company eligible and deferred namedcompany FK repaired by message callback', async (t) => {
  const f = await fixture(t);
  f.h.clock.advance(1000);
  const company = ensureCompany(f.ctx, 'New inclusion company');
  f.h.db.run('UPDATE chat SET named_company_id=? WHERE id=?', company, f.chatId);
  const version = companyVersion(f.h.db),
    result = purgeCallbacks(f, []);
  assert.deepEqual(result.removedCompanyIds, [company]);
  assert.ok(companyVersion(f.h.db) > version);
  assert.deepEqual(f.h.db.all('PRAGMA foreign_key_check'), []);
});

test('graph callback rollback restores identity/contact/evidence/company/participants and caller message rows', async (t) => {
  const f = await fixture(t),
    m = f.message(f.chatId);
  setContactCompany(f.agent, f.contactId, { company: { name: 'Rollback company' }, evidenceMessageIds: [m] });
  setContactRole(f.agent, f.contactId, { category: 'finance', dealsAbout: 'Rollback role', evidenceMessageIds: [m] });
  const before = JSON.stringify(getContact(f.ctx, f.contactId)),
    version = companyVersion(f.h.db);
  assert.throws(
    () =>
      f.h.db.tx(() => {
        f.h.db.run('PRAGMA defer_foreign_keys=ON');
        forgetMessages(f.ctx, { messageIds: [m], chatId: f.chatId });
        deleteMessages(f.ctx, [m]);
        throw new Error('Injected failure');
      }),
    /Injected/,
  );
  assert.equal(JSON.stringify(getContact(f.ctx, f.contactId)), before);
  assert.equal(companyVersion(f.h.db), version);
  const foreign = f.message(f.otherChatId);
  assert.throws(() => forgetMessages(f.ctx, { messageIds: [foreign], chatId: f.chatId }), /another chat/);
});

test('R31 otherchat role evidence retains agent role; alias and notsame records of deleted companies are removed', async (t) => {
  const f = await fixture(t),
    a = f.message(f.chatId),
    b = f.message(f.otherChatId);
  setContactRole(f.agent, f.contactId, {
    category: 'technical',
    dealsAbout: 'Surviving evidence',
    evidenceMessageIds: [a, b],
  });
  setContactCompany(f.agent, f.contactId, { company: { name: 'Only local company' }, evidenceMessageIds: [a] });
  const id = getContact(f.ctx, f.contactId).companies[0]?.id;
  assert.ok(id);
  addCompanyAlias(f.ctx, id, 'Local alias');
  markNotSame(f.ctx, 'Local partial', id);
  const result = purgeCallbacks(f, [a]);
  assert.deepEqual(result.removedCompanyIds, [id]);
  assert.equal(getContact(f.ctx, f.contactId).roleCategory, 'technical');
  assert.deepEqual(
    getContact(f.ctx, f.contactId).roleEvidence.map((m) => m.id),
    [b],
  );
  assert.deepEqual(f.h.db.all('SELECT * FROM company_alias WHERE company_id=?', id), []);
  assert.deepEqual(f.h.db.all('SELECT * FROM company_not_same WHERE company_id=?', id), []);
});

test('R31 open review naming a company by normalized alias protects it until settlement', async (t) => {
  const f = await fixture(t),
    a = f.message(f.chatId);
  setContactCompany(f.agent, f.contactId, { company: { name: 'Agent candidate' }, evidenceMessageIds: [a] });
  const id = getContact(f.ctx, f.contactId).companies[0]?.id;
  assert.ok(id);
  addCompanyAlias(f.ctx, id, 'Candidate alias');
  const at = f.h.clock.now().toISOString();
  f.h.db.run(
    "INSERT INTO review_item(kind,group_key,chat_id,proposal,why,confidence,reason,status,created_at,updated_at) VALUES ('contact_company','alias-review',?,?,'low_confidence',1,'Fixture','open',?,?)",
    f.otherChatId,
    JSON.stringify({ kind: 'contact_company', contactId: f.contactId, company: { name: 'CANDIDATE ALIAS LLC' } }),
    at,
    at,
  );
  assert.deepEqual(purgeCallbacks(f, [a]).removedCompanyIds, []);
});

test('R31 log failure inside graph callback rolls back participation, reset and company deletion', async (t) => {
  const f = await fixture(t),
    a = f.message(f.chatId);
  setContactCompany(f.agent, f.contactId, { company: { name: 'Reset rollback' }, evidenceMessageIds: [a] });
  const before = JSON.stringify(getContact(f.ctx, f.contactId));
  f.h.db.run(
    "CREATE TRIGGER fail_forget BEFORE INSERT ON action_log WHEN NEW.action='company.update' BEGIN SELECT RAISE(ABORT,'callback log failure'); END",
  );
  assert.throws(
    () =>
      f.h.db.tx(() => {
        f.h.db.run('PRAGMA defer_foreign_keys=ON');
        forgetMessages(f.ctx, { messageIds: [a], chatId: f.chatId });
      }),
    /callback log failure/,
  );
  assert.equal(JSON.stringify(getContact(f.ctx, f.contactId)), before);
});
