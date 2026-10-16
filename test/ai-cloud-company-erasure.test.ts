import assert from 'node:assert/strict';
import test from 'node:test';
import { onlyCompany, physicalAbsent, transitiveCompany, withdrawal } from '../src/agent/cloud-company-testing.ts';
import { cloudFixture, completed, decision, jsonResponse, recording } from '../src/agent/cloud-testing.ts';
import { createCard } from '../src/board/index.ts';
import {
  addCompanyAlias,
  ensureCompany,
  getCompany,
  getContact,
  renameCompany,
  setContactCompany,
} from '../src/graph/index.ts';

for (const human of ['rename', 'link', 'alias', 'card'] as const)
  test(`F1 actual transitive generated company with human ${human} preserves the human value and erases unsafe name`, async (t) => {
    const marker = 'ERASE_COMPANY_Ünicode_QZX';
    const { h, company, contact } = await transitiveCompany(t, marker);
    if (human === 'rename') renameCompany(h.ctx, company, 'Human corrected business');
    if (human === 'link') setContactCompany(h.ctx, contact, { company: { id: company }, evidenceMessageIds: [] });
    if (human === 'alias') addCompanyAlias(h.ctx, company, 'Human independent alias');
    let card: number | null = null;
    if (human === 'card') card = createCard(h.ctx, { laneId: h.lane.id, title: 'Human card', companyId: company }).id;
    await h.restart();
    withdrawal(h)();
    physicalAbsent(h, marker);
    const kept = getCompany(h.ctx, company);
    assert.equal(
      kept.name,
      human === 'rename'
        ? 'Human corrected business'
        : human === 'alias'
          ? 'Human independent alias'
          : '(name removed)',
    );
    assert.equal(
      getContact(h.ctx, contact).companies.some((c) => c.id === company),
      human === 'link',
    );
    if (card)
      assert.equal(
        h.db.get<{ company_id: number }>('SELECT company_id FROM card WHERE id=?', card)?.company_id,
        company,
      );
    assert.deepEqual(h.db.all('PRAGMA foreign_key_check'), []);
    if (human === 'rename' || human === 'alias') {
      await h.restart();
      withdrawal(h, 'other')();
      assert.equal(getCompany(h.ctx, company).name, kept.name);
      physicalAbsent(h, marker);
    }
  });

test('F1 complete independent generated company and link survive unrelated withdrawal, cold reopen, and a second withdrawal erases its own support', async (t) => {
  const h = await cloudFixture(t, { threshold: 0, otherText: 'Independent retained message' });
  h.handlers.general = async (input) =>
    jsonResponse(completed(decision(input, { disposition: 'none', laneId: null, title: null, summary: null })));
  const account = h.db.get<{ id: number }>('SELECT id FROM channel_account')?.id;
  assert.ok(account);
  h.app.host.includeChat(h.ctx, account, 'other', { company: null, agreedWordingVersion: 1 });
  await h.app.host.settle();
  await h.deliver('three');
  await h.app.pipeline.drain();
  h.handlers.general = async (input) => jsonResponse(completed(onlyCompany(input, 'Independent generated business')));
  await h.deliver('other');
  await h.app.pipeline.drain();
  const c = h.db.get<{ id: number }>("SELECT id FROM company WHERE name='Independent generated business'")?.id;
  assert.ok(c);
  const raw = h.db.get<{ raw: string }>(
    "SELECT d.raw FROM decision d JOIN message m ON m.id=d.message_id WHERE m.message_key='other'",
  )?.raw;
  assert.equal(JSON.parse(raw ?? '{}').__withdrawalContext.unknown, false);
  await h.restart();
  withdrawal(h)();
  assert.equal(getCompany(h.ctx, c).name, 'Independent generated business');
  assert.ok(h.db.get('SELECT company_id FROM contact_company WHERE company_id=?', c));
  await h.restart();
  withdrawal(h, 'other')();
  assert.equal(h.db.get('SELECT id FROM company WHERE id=?', c), undefined);
  physicalAbsent(h, 'Independent generated business');
});

test('F1 cleanup company-owner fault rolls back all SQL and permission state; retry after cold reconstruction physically erases', async (t) => {
  const marker = 'ERASE_ATOMIC_COMPANY_QZX';
  const { h } = await transitiveCompany(t, marker);
  await h.restart();
  const tables = [
    'company',
    'contact_company',
    'message',
    'decision',
    'action_log',
    'chat',
    'account_chat',
    'chat_selection',
    'evidence',
    'review_item',
  ];
  const snapshot = () => tables.map((table) => h.db.all(`SELECT * FROM ${table} ORDER BY rowid`));
  const before = snapshot();
  h.db.run(
    "CREATE TEMP TRIGGER fail_company_erasure BEFORE DELETE ON company BEGIN SELECT RAISE(ABORT,'synthetic company cleanup fault'); END",
  );
  assert.throws(withdrawal(h), /synthetic company cleanup fault/);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(h.db.all('PRAGMA foreign_key_check'), []);
  assert.equal(h.db.get<{ defer_foreign_keys: number }>('PRAGMA defer_foreign_keys')?.defer_foreign_keys, 0);
  h.db.run('DROP TRIGGER fail_company_erasure');
  withdrawal(h)();
  physicalAbsent(h, marker);
});

for (const late of ['success', 'reject'] as const)
  test(`F1 actual company-producing held provider ${late} cannot recreate erased context`, async (t) => {
    const { h } = await transitiveCompany(t, 'ERASE_HELD_COMPANY_QZX');
    // Reinclude after withdrawal; the new genuine version uses a held response.
    // Retained B already supplied the company; changing the source selection fences it.
    h.db.run("UPDATE message SET version=version+1 WHERE message_key='other'");
    const entered = Promise.withResolvers<void>(),
      held = Promise.withResolvers<Response>();
    let response: Response | null = null;
    h.handlers.general = async (input) => {
      response = jsonResponse(completed(onlyCompany(input, 'ERASE_HELD_COMPANY_QZX')));
      entered.resolve();
      return held.promise;
    };
    const pending = h.app.pipeline.processNext();
    await entered.promise;
    withdrawal(h)();
    assert.equal(await pending, null);
    if (late === 'success') {
      assert.ok(response);
      held.resolve(response);
    } else held.reject(new Error('private late rejection'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    physicalAbsent(h, 'ERASE_HELD_COMPANY_QZX');
    assert.equal(h.db.get('SELECT id FROM company'), undefined);
  });

test('F1 legacy company context without output pointers is unknown and erased, while v2 card and role parsing stays compatible', async (t) => {
  const marker = 'ERASE_LEGACY_COMPANY_QZX';
  const { h, company } = await transitiveCompany(t, marker);
  // Downgrade only private metadata on genuine owner writes to the old v2
  // representation; never fabricate an output or a support assertion.
  for (const row of h.db.all<{ id: number; raw: string }>('SELECT id,raw FROM decision')) {
    const raw = JSON.parse(row.raw);
    const c = raw.__withdrawalContext;
    if (c) {
      delete c.companies;
      delete c.companyLinks;
      delete c.cardCompanies;
      delete c.references;
    }
    h.db.run('UPDATE decision SET raw=? WHERE id=?', JSON.stringify(raw), row.id);
  }
  await h.restart();
  withdrawal(h)();
  assert.equal(h.db.get('SELECT id FROM company WHERE id=?', company), undefined);
  physicalAbsent(h, marker);
});

test('F1 actual generated company flows into retained card company/text and reference; full owner cleanup erases all copies', async (t) => {
  const marker = 'ERASE_ALL_STORES_COMPANY_QZX';
  const next = recording().find((line) => line.t === 'message' && line.chatKey === 'other');
  assert.ok(next && next.t === 'message');
  const { h, company, contact } = await transitiveCompany(t, marker, [
    {
      ...next,
      message: {
        ...next.message,
        key: 'followup',
        nativeId: 'followup',
        cursor: '5',
        sentAt: '2026-09-01T10:00:05.000Z',
        text: 'Follow up Independent human business',
      },
    },
    { t: 'mark', name: 'followup' },
  ]);
  const target = ensureCompany(h.ctx, 'Independent human business');
  setContactCompany(h.ctx, contact, { company: { id: target }, evidenceMessageIds: [] });
  h.handlers.general = async (input) => {
    assert.ok(input.companies.some((c) => c.id === company));
    assert.ok(input.companies.some((c) => c.id === target));
    return jsonResponse(
      completed(
        decision(input, {
          title: marker,
          summary: marker,
          cardCompanyId: company,
          mentions: [{ name: 'Independent human business', companyId: target, confidence: 1 }],
        }),
      ),
    );
  };
  await h.deliver('followup');
  await h.app.pipeline.drain();
  const card = h.db.get<{ id: number }>('SELECT id FROM card WHERE company_id=?', company)?.id;
  assert.ok(card);
  assert.ok(h.db.get('SELECT id FROM company_reference WHERE from_company_id=? AND to_company_id=?', company, target));
  await h.restart();
  withdrawal(h)();
  physicalAbsent(h, marker);
  assert.equal(
    h.db.get<{ company_id: number | null }>('SELECT company_id FROM card WHERE id=?', card)?.company_id,
    null,
  );
  assert.equal(h.db.get('SELECT id FROM company_reference'), undefined);
  assert.equal(getCompany(h.ctx, target).name, 'Independent human business');
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM message')?.n, 2);
});
