import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureCompany, ensureIdentity, setContactCompany } from '../graph/index.ts';
import { archiveCard, attachMessage, candidateCards, createCard, createLane, dismissCardOffer } from './index.ts';
import { fixture } from './test-fixture.ts';

test('candidateCards all own plus10 recent other-chat sharedcontact/company, stable dismissals and archive exclusions', async (t) => {
  const f = await fixture(t),
    lane = createLane(f.ctx, {
      name: 'Work',
      sop: 'Work',
      stages: [
        { name: 'New', criteria: '' },
        { name: 'Done', criteria: 'Done' },
      ],
    });
  const own = Array.from({ length: 12 }, (_, n) =>
    createCard(f.ctx, { laneId: lane.id, title: `Own ${n}`, chatId: f.chatId }),
  );
  const other = Array.from({ length: 12 }, (_, n) => {
    const card = createCard(f.ctx, { laneId: lane.id, title: `Other ${n}`, chatId: f.otherChatId });
    f.h.clock.advance(1000);
    attachMessage(f.ctx, f.message(f.otherChatId), card.id);
    return card;
  });
  assert.equal(candidateCards(f.ctx, f.chatId).filter((r) => r.link === 'this_chat').length, 12);
  assert.deepEqual(
    candidateCards(f.ctx, f.chatId)
      .filter((r) => r.link === 'other_chat')
      .map((r) => r.cardId),
    other
      .slice(-10)
      .reverse()
      .map((c) => c.id),
  );
  dismissCardOffer(f.ctx, other[11]?.id as number, f.chatId);
  archiveCard(f.ctx, other[10]?.id as number);
  assert.deepEqual(
    candidateCards(f.ctx, f.chatId)
      .filter((r) => r.link === 'other_chat')
      .map((r) => r.cardId),
    other
      .slice(0, 10)
      .reverse()
      .map((c) => c.id),
  );
  const company = ensureCompany(f.ctx, 'Named company');
  f.h.db.run('UPDATE chat SET named_company_id=? WHERE id=?', company, f.chatId);
  const identity = ensureIdentity(f.ctx, {
    channel: 'fixture',
    userKey: 'unrelated',
    displayName: 'Different',
    handle: null,
  });
  const separate = f.chat('separate', 0, identity.identityId);
  const byCompany = createCard(f.ctx, {
    laneId: lane.id,
    title: 'Company match',
    chatId: separate,
    companyId: company,
  });
  f.h.clock.advance(1000);
  attachMessage(f.ctx, f.message(separate, 'Company', identity.identityId), byCompany.id);
  assert.ok(candidateCards(f.ctx, f.chatId).some((c) => c.cardId === byCompany.id));
  const unrelated = createCard(f.ctx, { laneId: lane.id, title: 'Unrelated', chatId: separate });
  assert.ok(!candidateCards(f.ctx, f.chatId).some((c) => c.cardId === unrelated.id));
  assert.equal(candidateCards(f.ctx, f.chatId).length, own.length + 10);
});

test('candidateCards participantcompany qualifies and removed human links cease qualifying', async (t) => {
  const f = await fixture(t),
    lane = createLane(f.ctx, {
      name: 'Work',
      sop: 'Work',
      stages: [
        { name: 'New', criteria: '' },
        { name: 'Done', criteria: 'Done' },
      ],
    });
  const company = ensureCompany(f.ctx, 'Employer');
  setContactCompany(f.ctx, f.contactId, { company: { id: company }, evidenceMessageIds: [] });
  const emptyChat = f.chat('no-shared-contact', 0, null);
  const card = createCard(f.ctx, { laneId: lane.id, title: 'Employer work', companyId: company, chatId: emptyChat });
  assert.deepEqual(candidateCards(f.ctx, f.chatId), [{ cardId: card.id, link: 'other_chat' }]);
  f.h.db.run('UPDATE contact_company SET removed=1 WHERE contact_id=? AND company_id=?', f.contactId, company);
  assert.deepEqual(candidateCards(f.ctx, f.chatId), []);
});
