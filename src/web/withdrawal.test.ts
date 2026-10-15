import assert from 'node:assert/strict';
import test from 'node:test';
import { createCredential, setSetting } from '../auth/index.ts';
import { snapshot, withdrawalFixture } from '../purge/withdrawal-fixture.ts';

test('R31 actual HTTP only deletes after exact human confirmation/session/Origin/owner/included scope', async (t) => {
  const f = await withdrawalFixture(t);
  const { h } = f;
  const cookie = h.cookieFor('alice');
  const path = `/settings/accounts/${f.alice}/chats/${f.chatId}/withdraw`;
  const before = snapshot(f.ctx);
  const page = await (await h.get(`/settings/accounts/${f.alice}/chats`, { cookie })).text();
  assert.match(page, new RegExp(`action="${path}"`));
  assert.match(page, /name="confirm" value="withdraw" required/);
  assert.match(page, /ALL connected accounts/);
  assert.match(page, /does not delete Telegram messages/);
  assert.match(page, /Shared human values are retained/);
  const confirmation = page.match(
    /<details><summary>Withdraw chat and delete imported data<\/summary>([\s\S]*?)<\/details>/,
  )?.[1];
  assert.ok(confirmation);
  assert.match(confirmation, /App-wide cleanup: across OTHER chats too/);
  assert.match(
    confirmation,
    /saved agent decisions, movement audits, reviews, pending mentions, generated action history and human explanations for moves and reviews/,
  );
  assert.match(
    confirmation,
    /Generated card titles, summaries and contact roles are also cleared wherever they used this chat or their source is unknown/,
  );
  assert.match(confirmation, /Other chats keep their messages, and retained cards keep their lane and stage/);
  assert.match(confirmation, /current human-written card text, contact roles and company values/);
  assert.match(confirmation, new RegExp(`aria-describedby="withdraw-help-${f.chatId} withdraw-global-${f.chatId}"`));
  assert.match(
    confirmation,
    /required>I confirm withdrawal, deletion of this chat’s imported app data, and the app-wide cleanup across other chats described above/,
  );
  assert.match(confirmation, /You will need a new agreement/);
  assert.doesNotMatch(page, /withdrawal is unavailable/);
  for (const fields of [{}, { confirm: 'on' }, { confirm: 'withdraw', unexpected: 'value' }] as Record<
    string,
    string
  >[])
    assert.equal((await h.post(path, fields, { cookie })).status, 422);
  assert.equal((await h.get(path, { cookie })).status, 404);
  assert.equal((await h.post(path, { confirm: 'withdraw' })).status, 401);
  assert.equal((await h.post(path, { confirm: 'withdraw' }, { cookie: h.cookieFor('bob') })).status, 403);
  assert.equal(
    (
      await h.post(
        `/settings/accounts/${f.bob}/chats/${f.otherChat}/withdraw`,
        { confirm: 'withdraw' },
        { cookie: h.cookieFor('bob') },
      )
    ).status,
    403,
  );
  assert.equal(
    (await h.post(`/settings/accounts/${f.alice}/chats/999999/withdraw`, { confirm: 'withdraw' }, { cookie })).status,
    403,
  );
  for (const origin of ['', 'http://evil.invalid', 'http://localhost:8788']) {
    const headers = new Headers({ Cookie: cookie });
    if (origin) headers.set('Origin', origin);
    const response = await h.app.fetch(
      new Request(`http://localhost:8787${path}`, {
        method: 'POST',
        headers,
        body: new URLSearchParams({ confirm: 'withdraw' }),
      }),
    );
    assert.equal(response.status, 403);
  }
  assert.deepEqual(snapshot(f.ctx), before);
  const credential = createCredential(f.ctx, { name: 'Synthetic withdrawal token', scopeMessages: true });
  const afterCredential = snapshot(f.ctx);
  const bearerOnly = await h.app.fetch(
    new Request(`http://localhost:8787${path}`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:8787', Authorization: `Bearer ${credential.token}` },
      body: new URLSearchParams({ confirm: 'withdraw' }),
    }),
  );
  assert.equal(bearerOnly.status, 401);
  await assert.rejects(
    h.mcp('withdraw_chat', { accountId: f.alice, chatId: f.chatId, confirm: 'withdraw' }, credential.token),
  );
  assert.deepEqual(snapshot(f.ctx), afterCredential);
  assert.equal((await h.post(path, { confirm: 'withdraw' }, { cookie })).status, 303);
  assert.equal(h.db.get('SELECT id FROM message WHERE chat_id=?', f.chatId), undefined);
  assert.equal((await h.post(path, { confirm: 'withdraw' }, { cookie })).status, 403);
  const ownPage = await (await h.get(`/settings/accounts/${f.alice}/chats`, { cookie })).text();
  const otherPage = await (await h.get(`/settings/accounts/${f.bob}/chats`, { cookie: h.cookieFor('bob') })).text();
  for (const markup of [ownPage, otherPage]) {
    assert.match(markup, /withdrawn/);
    assert.match(markup, /Withdrawn by alice/);
    assert.match(markup, /Agreement records/);
  }
  setSetting(f.ctx, 'require_agreement', false);
  const reinclude = `/settings/accounts/${f.alice}/chats/include`;
  assert.equal(
    (await h.post(reinclude, { chatKey: 'selected', company: '', agreedWordingVersion: '' }, { cookie })).status,
    422,
  );
  assert.equal(
    (await h.post(reinclude, { chatKey: 'selected', company: '', agreedWordingVersion: '1' }, { cookie })).status,
    303,
  );
  await h.app.host.settle();
});
