import assert from 'node:assert/strict';
import test from 'node:test';
import { getSetting } from '../auth/index.ts';
import { webTestApp } from './testing.ts';

test('owner includes and re-includes through native forms without participant attestation or fabricated confirmation', async (t) => {
  const h = await webTestApp(t, true);
  const ctx = h.ctxFor('alice');
  const cookie = h.cookieFor('alice');
  await h.control.advanceTo('setup');
  await h.app.start();
  const account = h.app.host.listAccounts(ctx)[0];
  assert.ok(account);
  assert.equal(getSetting(h.db, 'require_agreement'), true, 'old persisted/default policy cannot block the new UI');
  const path = `/settings/accounts/${account.id}/chats`;
  const initial = await (await h.get(path, { cookie })).text();
  assert.doesNotMatch(
    initial,
    /The people in this chat have agreed|agreedWordingVersion|Reconfirm agreement|Agreement records/,
  );
  assert.match(initial, /Company name \(optional\)/);
  assert.equal((await h.post(`${path}/include`, { chatKey: 'client', company: '' })).status, 401);
  assert.equal(
    (await h.post(`${path}/include`, { chatKey: 'client', company: '' }, { cookie: h.cookieFor('jordan') })).status,
    403,
  );
  const forged = await h.app.fetch(
    new Request(`http://localhost:8787${path}/include`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'https://evil.invalid' },
      body: new URLSearchParams({ chatKey: 'client', company: '' }),
    }),
  );
  assert.equal(forged.status, 403);
  assert.equal(h.db.get('SELECT id FROM chat'), undefined);
  assert.equal((await h.post(`${path}/include`, { chatKey: 'client', company: '' }, { cookie })).status, 303);
  await h.app.host.settle();
  await h.control.advanceTo('delivered');
  await h.app.host.settle();
  const chat = h.db.get<{ id: number }>("SELECT id FROM chat WHERE chat_key='client'");
  assert.ok(chat);
  assert.ok(h.db.get<{ n: number }>('SELECT count(*) n FROM message WHERE chat_id=?', chat.id)?.n);
  assert.equal(h.db.get<{ n: number }>("SELECT count(*) n FROM chat_agreement WHERE kind='confirmed'")?.n, 0);
  assert.equal((await h.post(`${path}/include`, { chatKey: 'client', company: '' }, { cookie })).status, 409);
  const page = await (await h.get(path, { cookie })).text();
  assert.doesNotMatch(
    page,
    /The people in this chat have agreed|agreedWordingVersion|Reconfirm agreement|Confirmation out of date/,
  );
  assert.match(page, /name="confirm" value="withdraw" required/);
  assert.equal((await h.post(`${path}/${chat.id}/withdraw`, {}, { cookie })).status, 422);
  assert.equal((await h.post(`${path}/${chat.id}/withdraw`, { confirm: 'withdraw' }, { cookie })).status, 303);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) n FROM message WHERE chat_id=?', chat.id)?.n, 0);
  const withdrawn = await (await h.get(path, { cookie })).text();
  assert.doesNotMatch(withdrawn, /The people in this chat have agreed|agreedWordingVersion|new agreement/);
  assert.equal((await h.post(`${path}/include`, { chatKey: 'client', company: '' }, { cookie })).status, 303);
  await h.app.host.settle();
  assert.equal(
    h.db.get<{ decision: string }>(
      'SELECT decision FROM chat_selection WHERE account_id=? AND chat_key=?',
      account.id,
      'client',
    )?.decision,
    'included',
  );
  assert.equal(h.db.get<{ n: number }>("SELECT count(*) n FROM chat_agreement WHERE kind='confirmed'")?.n, 0);
  const settings = await (await h.get('/settings', { cookie })).text();
  assert.doesNotMatch(settings, /name="require_agreement"|Require a statement of agreement/);
  assert.equal(
    (
      await h.post(
        '/settings',
        { review_threshold: '1', keep_deleted_text: 'on', role_categories: 'unknown' },
        { cookie },
      )
    ).status,
    303,
  );
  assert.equal(getSetting(h.db, 'require_agreement'), true, 'saving visible settings must not rewrite legacy records');
});
