import assert from 'node:assert/strict';
import test from 'node:test';
import { getContact } from '../graph/index.ts';
import { history } from '../log/index.ts';
import { hiddenValue, ingestFixture, webTestApp } from './testing.ts';

test('R20/R3 company/contact pages, role/company corrections and text search expose actual stored evidence', async (t) => {
  const h = await webTestApp(t, true);
  const { contactId, messageIds } = await ingestFixture(h);
  const cookie = h.cookieFor('alice');
  const path = `/contacts/${contactId}`;
  assert.equal((await h.post(path, { displayName: 'Bob <human>' }, { cookie })).status, 303);
  assert.equal(
    (
      await h.post(
        `${path}/role`,
        {
          category: 'finance',
          dealsAbout: 'Invoice evidence',
          evidenceMessageIds: String(messageIds[0]),
          reason: 'Human correction',
        },
        { cookie },
      )
    ).status,
    303,
  );
  assert.equal(
    (
      await h.post(
        `${path}/role`,
        { category: 'technical', dealsAbout: '', evidenceMessageIds: '', reason: 'Missing evidence' },
        { cookie },
      )
    ).status,
    422,
  );
  assert.equal(
    (
      await h.post(
        `${path}/companies`,
        { company: 'Evidence company', evidenceMessageIds: String(messageIds[0]), reason: 'Linked evidence' },
        { cookie },
      )
    ).status,
    303,
  );
  const contact = getContact(h.ctxFor('alice'), contactId);
  const company = contact.companies[0];
  assert.ok(company);
  const markup = await (await h.get(path, { cookie })).text();
  assert.match(markup, /Bob &lt;human&gt;/);
  assert.match(markup, /Invoice evidence/);
  assert.match(markup, /Role evidence/);
  assert.match(markup, /Please integrate our technical system/);
  const page = await h.get(`/companies/${company.id}`, { cookie: h.cookieFor('jordan') });
  assert.equal(page.status, 200);
  const companyHtml = await page.text();
  assert.match(companyHtml, /alice/);
  assert.match(companyHtml, /Please integrate our technical system/);
  assert.equal((await h.post(`/companies/${company.id}`, { name: 'Renamed evidence' }, { cookie })).status, 303);
  assert.equal(
    (await h.post(`/companies/${company.id}/aliases`, { alias: 'Former evidence' }, { cookie })).status,
    303,
  );
  assert.match(await (await h.get('/companies?q=Former', { cookie })).text(), /Renamed evidence/);
  const filtered = await (await h.get(`/contacts?companyId=${company.id}&roleCategory=finance`, { cookie })).text();
  assert.match(filtered, /Bob &lt;human&gt;/);
  const excluded = await (await h.get(`/contacts?companyId=${company.id}&roleCategory=technical`, { cookie })).text();
  assert.doesNotMatch(excluded, /Bob &lt;human&gt;/);
  const search = await (await h.get('/search?q=technical', { cookie })).text();
  assert.match(search, /Renamed evidence/);
  assert.match(search, /Acme integration/);
  assert.match(search, /Please integrate our technical system/);
  assert.equal((await h.get('/log?subjectKind=contact&subjectId=', { cookie })).status, 200);
  assert.match(
    await (await h.get(`/log?subjectKind=contact&subjectId=${contactId}`, { cookie })).text(),
    /Human correction/,
  );
  assert.equal((await h.post(`${path}/companies/${company.id}/remove`, {}, { cookie })).status, 303);
  assert.equal(getContact(h.ctxFor('alice'), contactId).companies.length, 0);
  assert.equal(history(h.ctxFor('alice'), { action: 'contact.set_role' })[0]?.actor.name, 'alice');
});

test('Human contact-company similar advisory cannot be bypassed with unsigned choice or changed evidence', async (t) => {
  const h = await webTestApp(t, true);
  const { contactId, messageIds } = await ingestFixture(h);
  const cookie = h.cookieFor('alice');
  const path = `/contacts/${contactId}/companies`;
  assert.equal(
    (
      await h.post(
        path,
        { company: 'Globex Logistics', evidenceMessageIds: String(messageIds[0]), reason: 'First link' },
        { cookie },
      )
    ).status,
    303,
  );
  const fields = { company: 'Globex', evidenceMessageIds: String(messageIds[0]), reason: 'Second link' };
  const first = await h.post(path, fields, { cookie });
  assert.equal(first.status, 200);
  const challenge = hiddenValue(await first.text(), 'challenge');
  assert.equal((await h.post(path, { ...fields, choice: 'separate' }, { cookie })).status, 422);
  assert.equal(
    (await h.post(path, { ...fields, choice: 'separate', challenge }, { cookie: h.cookieFor('jordan') })).status,
    422,
  );
  assert.equal(
    (
      await h.post(
        path,
        { ...fields, evidenceMessageIds: String(messageIds[1]), choice: 'separate', challenge },
        { cookie },
      )
    ).status,
    422,
  );
  assert.equal((await h.post(path, { ...fields, choice: 'separate', challenge }, { cookie })).status, 303);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM company')?.n, 2);
  assert.equal(getContact(h.ctxFor('alice'), contactId).companies.length, 2);
});
