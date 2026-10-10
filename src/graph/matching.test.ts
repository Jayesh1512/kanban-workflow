import assert from 'node:assert/strict';
import test from 'node:test';
import { createCard, createLane } from '../board/index.ts';
import { fixture } from '../board/test-fixture.ts';
import {
  addCompanyAlias,
  candidateCompanies,
  companyVersion,
  ensureCompany,
  markNotSame,
  normalizeCompanyName,
  resolveCompany,
  setContactCompany,
} from './index.ts';

test('R18 variants/legal suffixes/exact/alias/partial/initial/trigram and remembered not-same scores', async (t) => {
  const f = await fixture(t);
  assert.equal(normalizeCompanyName('  ÁCME, Corporation Pvt. Ltd. '), 'acme');
  assert.equal(normalizeCompanyName('Private Eye Inc.'), 'private eye');
  const acme = ensureCompany(f.ctx, 'Ácme Corporation');
  assert.equal(ensureCompany(f.ctx, 'ACME Pvt Ltd'), acme);
  assert.deepEqual(resolveCompany(f.ctx, 'acme'), { match: 'exact', companyId: acme, score: 1 });
  const globex = ensureCompany(f.ctx, 'Globex Logistics');
  assert.deepEqual(resolveCompany(f.agent, 'Globex'), { match: 'similar', companyId: globex, score: 0.9 });
  const ibm = ensureCompany(f.ctx, 'International Business Machines');
  assert.deepEqual(resolveCompany(f.ctx, 'IBM'), { match: 'similar', companyId: ibm, score: 0.8 });
  const alphabet = ensureCompany(f.ctx, 'Alphabet');
  const fuzzy = resolveCompany(f.ctx, 'Alphabets');
  assert.equal(fuzzy.match, 'similar');
  assert.equal(fuzzy.companyId, alphabet);
  assert.ok(fuzzy.score >= 0.6 && fuzzy.score < 0.9);
  addCompanyAlias(f.ctx, globex, 'GX');
  assert.deepEqual(resolveCompany(f.ctx, 'gx'), { match: 'alias', companyId: globex, score: 1 });
  const v = companyVersion(f.h.db);
  markNotSame(f.ctx, 'Globex', globex);
  assert.ok(companyVersion(f.h.db) > v);
  assert.equal(resolveCompany(f.ctx, 'Globex').match, 'none');
  const separate = ensureCompany(f.ctx, 'Globex');
  assert.notEqual(separate, globex);
  assert.equal(resolveCompany(f.ctx, 'Globex').companyId, separate);
  assert.equal(resolveCompany(f.ctx, 'Unrelated zxqv').match, 'none');
});

test('R18 similar agent participant name cannot silently create; exact aliases can create guarded participant links', async (t) => {
  const f = await fixture(t),
    m = f.message(f.chatId),
    company = ensureCompany(f.ctx, 'Globex Logistics');
  const before = companyVersion(f.h.db);
  assert.throws(
    () => setContactCompany(f.agent, f.contactId, { company: { name: 'Globex' }, evidenceMessageIds: [m] }),
    /Similar company/,
  );
  assert.equal(companyVersion(f.h.db), before);
  addCompanyAlias(f.ctx, company, 'Globex');
  setContactCompany(f.agent, f.contactId, { company: { name: 'Globex' }, evidenceMessageIds: [m] });
  assert.equal(f.h.db.get<{ company_id: number }>('SELECT company_id FROM contact_company')?.company_id, company);
});

test('candidateCompanies prioritizes participant/named/card then text scores with stable cap15', async (t) => {
  const f = await fixture(t),
    m = f.message(f.chatId);
  const participant = ensureCompany(f.ctx, 'Participant'),
    named = ensureCompany(f.ctx, 'Named'),
    cardCompany = ensureCompany(f.ctx, 'Card company');
  setContactCompany(f.ctx, f.contactId, { company: { id: participant }, evidenceMessageIds: [m] });
  f.h.db.run('UPDATE chat SET named_company_id=? WHERE id=?', named, f.chatId);
  const lane = createLane(f.ctx, {
    name: 'Work',
    sop: 'Work',
    stages: [
      { name: 'New', criteria: '' },
      { name: 'Done', criteria: 'Done' },
    ],
  });
  const card = createCard(f.ctx, { laneId: lane.id, title: 'Work', companyId: cardCompany });
  const exact = ensureCompany(f.ctx, 'The unrelated exact');
  const similar = Array.from({ length: 20 }, (_, n) => ensureCompany(f.ctx, `The other ${n}`));
  const rows = candidateCompanies(f.agent, {
    chatId: f.chatId,
    text: 'The unrelated exact',
    cardIds: [card.id, card.id],
  });
  assert.deepEqual(
    rows.slice(0, 3).map((c) => [c.id, c.why]),
    [
      [participant, 'participant'],
      [named, 'named'],
      [cardCompany, 'card'],
    ],
  );
  assert.equal(rows[3]?.id, exact);
  assert.equal(rows.length, 15);
  assert.deepEqual(
    rows.slice(4).map((c) => c.id),
    similar.slice(0, 11),
  );
  assert.equal(new Set(rows.map((c) => c.id)).size, 15);
});

for (const word of ['the', 'group', 'global'])
  test(`matching advisory: ${word} deterministically saturates all15 equal rule(a) .9 slots without retuning`, async (t) => {
    const f = await fixture(t);
    const ids = Array.from({ length: 18 }, (_, n) => ensureCompany(f.ctx, `${word} distinctive ${n}`));
    assert.deepEqual(resolveCompany(f.ctx, word), { match: 'similar', companyId: ids[0] ?? null, score: 0.9 });
    const input = { chatId: f.chatId, text: word, cardIds: [] };
    assert.deepEqual(
      candidateCompanies(f.ctx, input).map((c) => c.id),
      ids.slice(0, 15),
    );
    markNotSame(f.ctx, word, ids[0] as number);
    assert.deepEqual(
      candidateCompanies(f.ctx, input).map((c) => c.id),
      ids.slice(1, 16),
    );
  });
