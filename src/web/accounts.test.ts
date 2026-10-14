import assert from 'node:assert/strict';
import test from 'node:test';
import { attr } from '../../test/html.ts';
import { ensureCompany } from '../graph/index.ts';
import { history } from '../log/index.ts';
import { hiddenValue, webTestApp } from './testing.ts';

test('R4/R5 HTTP generic account login and owner-only chat inclusion/agreement/exclusion use actual Host', async (t) => {
  const h = await webTestApp(t, true);
  const alice = h.cookieFor('alice');
  const jordan = h.cookieFor('jordan');
  await h.control.advanceTo('setup');
  await h.app.start();
  const accountId = h.app.host.listAccounts(h.ctxFor('alice'))[0]?.id;
  assert.ok(accountId);
  let chats = await h.get(`/settings/accounts/${accountId}/chats`, { cookie: alice });
  assert.equal(chats.status, 200);
  const text = await chats.text();
  assert.match(text, /Acme integration/);
  assert.match(text, /Unselected/);
  assert.doesNotMatch(text, /Please integrate|handle the invoice/);
  assert.doesNotMatch(text, /action="[^"]*\/withdraw"/);
  assert.equal((await h.get(`/settings/accounts/${accountId}/chats`, { cookie: jordan })).status, 403);
  assert.equal(
    (
      await h.post(
        `/settings/accounts/${accountId}/chats/include`,
        { chatKey: 'client', company: '', agreedWordingVersion: '1' },
        { cookie: jordan },
      )
    ).status,
    403,
  );
  assert.equal(
    (await h.post(`/settings/accounts/${accountId}/disconnect`, { confirm: 'on' }, { cookie: jordan })).status,
    403,
  );
  assert.equal(
    (
      await h.post(
        `/settings/accounts/${accountId}/chats/include`,
        { chatKey: 'client', company: '', agreedWordingVersion: '' },
        { cookie: alice },
      )
    ).status,
    422,
  );
  assert.equal(
    (
      await h.post(
        `/settings/accounts/${accountId}/chats/include`,
        { chatKey: 'client', company: '', agreedWordingVersion: '1' },
        { cookie: alice },
      )
    ).status,
    303,
  );
  await h.app.host.settle();
  await h.control.advanceTo('delivered');
  await h.app.host.settle();
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM message')?.n, 12);
  const chatId = h.db.get<{ id: number }>('SELECT id FROM chat')?.id;
  assert.ok(chatId);
  const stale = await (await h.get('/board', { cookie: alice })).text();
  assert.equal(attr(stale, 'my-chats', 'out-of-date'), '1');
  const jordanHtml = await (await h.get('/board', { cookie: jordan })).text();
  assert.equal(attr(jordanHtml, 'my-chats', 'connected'), null);
  assert.doesNotMatch(jordanHtml, /Acme integration|Unselected/);
  assert.equal(
    (
      await h.post(
        `/settings/accounts/${accountId}/chats/${chatId}/confirm`,
        { agreedWordingVersion: '1' },
        { cookie: alice },
      )
    ).status,
    303,
  );
  assert.equal(attr(await (await h.get('/board', { cookie: alice })).text(), 'my-chats', 'out-of-date'), '0');
  chats = await h.get(`/settings/accounts/${accountId}/chats`, { cookie: alice });
  const records = await chats.text();
  assert.match(records, /Agreement records/);
  assert.match(records, /The people in this chat have agreed/);
  assert.match(records, /alice · confirmed/);
  assert.equal(
    (await h.post(`/settings/accounts/${accountId}/chats/exclude`, { chatKey: 'client' }, { cookie: alice })).status,
    303,
  );
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM message')?.n, 12);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM chat_agreement')?.n, 2);
  assert.equal(
    (await h.post(`/settings/accounts/${accountId}/disconnect`, { confirm: 'on' }, { cookie: alice })).status,
    303,
  );
  const reconnect = await h.post(
    '/settings/accounts',
    { channel: 'fixture', acknowledgedNoticeVersion: '' },
    { cookie: alice },
  );
  assert.equal(reconnect.status, 303);
  const loginPage = await (await h.get('/settings/accounts', { cookie: alice })).text();
  assert.match(loginPage, /name="account"/);
  assert.equal(
    (await h.post(`/settings/accounts/${accountId}/login`, { account: 'alice' }, { cookie: jordan })).status,
    403,
  );
  assert.equal(
    (await h.post(`/settings/accounts/${accountId}/login`, { account: 'alice' }, { cookie: alice })).status,
    303,
  );
  assert.match(await (await h.get('/settings/accounts', { cookie: alice })).text(), /Account connected/);
});

test('R5.4 board counts remain unknown before cached listing and never become fabricated zero', async (t) => {
  const h = await webTestApp(t, true);
  const html = await (await h.get('/board', { cookie: h.cookieFor('alice') })).text();
  assert.equal(attr(html, 'my-chats', 'undecided'), '');
  assert.match(html, /Undecided chat count is unknown/);
});

test('Human include-chat company advisory requires a signed second POST and rejects forged or stale confirmation', async (t) => {
  const h = await webTestApp(t, true);
  const ctx = h.ctxFor('alice');
  const cookie = h.cookieFor('alice');
  const candidate = ensureCompany(ctx, 'Globex Logistics');
  await h.control.advanceTo('setup');
  await h.app.start();
  const accountId = h.app.host.listAccounts(ctx)[0]?.id;
  assert.ok(accountId);
  await h.app.host.listChats(ctx, accountId);
  const path = `/settings/accounts/${accountId}/chats/include`;
  const fields = { chatKey: 'client', company: 'Globex', agreedWordingVersion: '1' };
  const first = await h.post(path, fields, { cookie });
  assert.equal(first.status, 200);
  const markup = await first.text();
  assert.match(markup, /Globex Logistics/);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM company')?.n, 1);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM chat_selection')?.n, 0);
  const challenge = hiddenValue(markup, 'challenge');
  assert.equal((await h.post(path, { ...fields, choice: 'separate' }, { cookie })).status, 422);
  assert.equal(
    (await h.post(path, { ...fields, company: 'Globex different', choice: 'separate', challenge }, { cookie })).status,
    409,
  );
  assert.equal((await h.post(path, { ...fields, choice: 'candidate', challenge }, { cookie })).status, 303);
  await h.app.host.settle();
  assert.equal(h.db.get<{ id: number }>('SELECT named_company_id AS id FROM chat')?.id, candidate);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM company')?.n, 1);
  assert.equal(
    (await h.post(`/settings/accounts/${accountId}/chats/exclude`, { chatKey: 'client' }, { cookie })).status,
    303,
  );
  const firstSeparate = await h.post(path, fields, { cookie });
  const separateChallenge = hiddenValue(await firstSeparate.text(), 'challenge');
  h.clock.advance(600001);
  assert.equal(
    (await h.post(path, { ...fields, choice: 'separate', challenge: separateChallenge }, { cookie })).status,
    422,
  );
  const secondFresh = await h.post(path, fields, { cookie });
  const fresh = hiddenValue(await secondFresh.text(), 'challenge');
  assert.equal((await h.post(path, { ...fields, choice: 'separate', challenge: fresh }, { cookie })).status, 303);
  await h.app.host.settle();
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM company')?.n, 2);
  const includedLog = history(ctx, { action: 'chat.include' })[0];
  assert.ok(includedLog);
  assert.doesNotMatch(JSON.stringify(includedLog.after), /Globex/);
});
