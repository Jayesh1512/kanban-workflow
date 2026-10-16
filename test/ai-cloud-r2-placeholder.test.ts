import assert from 'node:assert/strict';
import test from 'node:test';
import { physicalAbsent, transitiveCompany, withdrawal } from '../src/agent/cloud-company-testing.ts';
import {
  addCompanyAlias,
  ensureCompany,
  getCompany,
  normalizeCompanyName,
  resolveCompany,
  setContactCompany,
} from '../src/graph/index.ts';

for (const route of ['name', 'alias', 'similar'] as const)
  test(`R2 F4 cold company erasure preserves unrelated human ${route} near the former placeholder`, async (t) => {
    const marker = 'R2_ERASE_COLLISION_Ünicode_"quoted"_\\QZX';
    const { h, company, contact } = await transitiveCompany(t, marker);
    setContactCompany(h.ctx, contact, { company: { id: company }, evidenceMessageIds: [] });
    const oldName = `Withdrawn Company ${company}`;
    const humanName =
      route === 'name' ? oldName : route === 'similar' ? `${oldName} Partners` : 'Independent human business';
    const control = ensureCompany(h.ctx, humanName);
    const alias = `  Wíthdrawn, Company ${company} LLC  `;
    if (route === 'alias') addCompanyAlias(h.ctx, control, alias);
    assert.notEqual(control, company);
    const independent = getCompany(h.ctx, control);
    await h.restart();
    withdrawal(h)();
    physicalAbsent(h, marker);
    assert.equal(getCompany(h.ctx, company).name, '(name removed)');
    assert.deepEqual(getCompany(h.ctx, control), independent);
    const norm = h.db.get<{ name_norm: string }>('SELECT name_norm FROM company WHERE id=?', company)?.name_norm;
    assert.ok(norm);
    assert.notEqual(
      normalizeCompanyName(norm),
      norm,
      'reserved punctuation is unreachable through public normalization',
    );
    assert.equal(norm.includes(String(company)), true);
    assert.equal(h.db.all('SELECT id FROM company').length, 2);
    assert.ok(h.db.get("SELECT contact_id FROM contact_company WHERE company_id=? AND set_by='human'", company));
    assert.equal(resolveCompany(h.ctx, humanName).companyId, control);
    if (route === 'alias') {
      assert.equal(normalizeCompanyName(alias), normalizeCompanyName(oldName));
      assert.deepEqual(resolveCompany(h.ctx, alias), { match: 'alias', companyId: control, score: 1 });
    }
    // The reserved identity cannot hijack subsequent ordinary public naming.
    assert.notEqual(ensureCompany(h.ctx, `:withdrawn-company:${company}`), company);
    assert.deepEqual(h.db.all('PRAGMA foreign_key_check'), []);
    await h.restart();
    assert.equal(getCompany(h.ctx, company).name, '(name removed)');
    assert.deepEqual(getCompany(h.ctx, control), independent);
    physicalAbsent(h, marker);
  });

test('R2 F4 reserved relabel owner-log fault rolls back collision case; cold retry erases', async (t) => {
  const marker = 'R2_COLLISION_LOG_FAULT_QZX';
  const { h, company, contact } = await transitiveCompany(t, marker);
  setContactCompany(h.ctx, contact, { company: { id: company }, evidenceMessageIds: [] });
  const control = ensureCompany(h.ctx, `Withdrawn Company ${company}`);
  await h.restart();
  const snapshot = () =>
    [
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
    ].map((table) => h.db.all(`SELECT * FROM ${table} ORDER BY rowid`));
  const before = snapshot();
  h.db.run(
    "CREATE TEMP TRIGGER fail_r2_relabel BEFORE INSERT ON action_log WHEN NEW.action='company.update' AND NEW.actor_kind='system' BEGIN SELECT RAISE(ABORT,'synthetic R2 relabel log fault'); END",
  );
  assert.throws(withdrawal(h), /synthetic R2 relabel log fault/);
  assert.deepEqual(snapshot(), before);
  assert.equal(getCompany(h.ctx, company).name, marker);
  h.db.run('DROP TRIGGER fail_r2_relabel');
  await h.restart();
  withdrawal(h)();
  physicalAbsent(h, marker);
  assert.equal(getCompany(h.ctx, company).name, '(name removed)');
  assert.equal(getCompany(h.ctx, control).name, `Withdrawn Company ${company}`);
  assert.deepEqual(h.db.all('PRAGMA foreign_key_check'), []);
});
