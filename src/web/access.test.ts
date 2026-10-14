import assert from 'node:assert/strict';
import test from 'node:test';
import { listCredentials, listTeammates } from '../auth/index.ts';
import { routeInventory } from './routes.ts';
import { webTestApp } from './testing.ts';

test('R26.1 exact four public routes, every other route requires session, and every POST checks exact Origin', async (t) => {
  const h = await webTestApp(t);
  const routes = routeInventory();
  assert.deepEqual(
    routes.filter((r) => r.public).map((r) => `${r.method} ${r.path}`),
    ['GET /login', 'POST /login', 'GET /static/app.css', 'GET /static/app.js'],
  );
  for (const route of routes) {
    const path = route.path.replaceAll(':id', '1').replaceAll(':companyId', '1').replaceAll(':chatId', '1');
    if (!route.public) {
      const r = route.method === 'GET' ? await h.get(path) : await h.post(path, {});
      assert.equal(r.status, route.method === 'GET' ? 303 : 401, `${route.method} ${path}`);
      if (route.method === 'GET') assert.equal(r.headers.get('location'), '/login');
    }
    if (route.method === 'POST')
      for (const origin of [undefined, 'http://localhost:8787.evil', 'http://127.0.0.1:8787']) {
        const headers = new Headers({ Cookie: h.cookieFor('alice') });
        if (origin) headers.set('Origin', origin);
        assert.equal(
          (await h.app.fetch(new Request(`http://localhost:8787${path}`, { method: 'POST', headers, body: '' })))
            .status,
          403,
          `${path} origin ${origin}`,
        );
      }
  }
  const login = await h.get('/login');
  assert.match(login.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.match(await login.text(), /autocomplete="current-password"/);
  assert.equal((await h.post('/login', { username: 'alice', password: 'incorrect' })).status, 401);
  const signed = await h.post('/login', { username: 'alice', password: 'synthetic-password' });
  assert.equal(signed.status, 303);
  const cookie = signed.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  assert.match(signed.headers.get('set-cookie') ?? '', /HttpOnly/);
  assert.match(signed.headers.get('set-cookie') ?? '', /SameSite=Lax/);
  assert.equal((await h.post('/logout', {}, { cookie })).status, 303);
  assert.equal((await h.get('/board', { cookie })).status, 303);
  assert.equal((await h.get('/signup')).status, 303);
});

test('R26.2/3 human teammate removal ends sessions and disconnects their owned account via system exception', async (t) => {
  const h = await webTestApp(t, true);
  const alice = h.cookieFor('alice');
  const jordan = h.cookieFor('jordan');
  const id = listTeammates(h.ctxFor('jordan')).find((t) => t.username === 'alice')?.id;
  assert.ok(id);
  assert.equal(
    (
      await h.post('/settings/teammates', {
        username: 'new',
        displayName: 'New teammate',
        password: 'Synthetic test only',
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await h.post(
        '/settings/teammates',
        { username: 'new', displayName: 'New teammate', password: 'Synthetic test only' },
        { cookie: jordan },
      )
    ).status,
    303,
  );
  assert.equal((await h.post(`/settings/teammates/${id}/remove`, {}, { cookie: jordan })).status, 422);
  assert.equal((await h.post(`/settings/teammates/${id}/remove`, { confirm: 'on' }, { cookie: jordan })).status, 303);
  assert.equal((await h.get('/board', { cookie: alice })).status, 303);
  assert.equal(
    h.db.get<{ state: string }>('SELECT state FROM channel_account WHERE teammate_id=?', id)?.state,
    'removed',
  );
  const entry = h.db.get<{ actor_kind: string }>("SELECT actor_kind FROM action_log WHERE action='account.disconnect'");
  assert.equal(entry?.actor_kind, 'system');
  const text = await (await h.get('/settings/teammates', { cookie: jordan })).text();
  assert.doesNotMatch(text, /Synthetic test only|password_hash|scrypt\$/);
});

test('R24.2 HTTP credential token is shown once to the creating session; text scope and revocation use real auth', async (t) => {
  const h = await webTestApp(t);
  const cookie = h.cookieFor('alice');
  assert.equal(
    (await h.post('/settings/credentials', { name: 'Scoped reader', scopeMessages: 'on' }, { cookie })).status,
    303,
  );
  const otherPage = await (await h.get('/settings/credentials', { cookie: h.cookieFor('jordan') })).text();
  assert.doesNotMatch(otherPage, /kbn_\d+_/);
  const shown = await (await h.get('/settings/credentials', { cookie })).text();
  assert.match(shown, /kbn_\d+_[A-Za-z0-9_-]{43}/);
  assert.doesNotMatch(await (await h.get('/settings/credentials', { cookie })).text(), /kbn_\d+_/);
  const credentials = listCredentials(h.ctxFor('alice'));
  assert.equal(credentials[0]?.scopeMessages, true);
  assert.ok(credentials[0]);
  assert.equal((await h.post(`/settings/credentials/${credentials[0].id}/revoke`, {}, { cookie })).status, 303);
  assert.equal(listCredentials(h.ctxFor('alice'))[0]?.revoked, true);
});

test('R13.3/R27 settings retain automatic-off and distinguish unavailable OpenAI/Jev without browser keys', async (t) => {
  const h = await webTestApp(t);
  const cookie = h.cookieFor('alice');
  const board = await (await h.get('/board', { cookie })).text();
  assert.match(board, /Automatic actions are off/);
  assert.match(board, /OpenAI · general analysis/);
  assert.match(board, /Jev · cross-lane judgment/);
  assert.match(board, /hosted availability unverified/);
  const settings = await (await h.get('/settings', { cookie })).text();
  assert.match(settings, /context leaves the machine/);
  assert.match(settings, /server administrator/);
  assert.match(settings, /TLS proxy/);
  assert.doesNotMatch(settings, /name="(?:apiKey|key|OPENAI_API_KEY|model)"/);
  assert.equal(
    (await h.post('/settings', { review_threshold: '2', role_categories: 'unknown' }, { cookie })).status,
    422,
  );
  assert.equal(
    (
      await h.post(
        '/settings',
        { review_threshold: '0.7', role_categories: 'finance\nunknown', require_agreement: 'on' },
        { cookie },
      )
    ).status,
    303,
  );
  assert.match(await (await h.get('/board', { cookie })).text(), /data-automatic-off="0"/);
  const js = await (await h.get('/static/app.js')).text();
  assert.doesNotMatch(js, /setInterval|board\/version|fetch\(/);
});

test('R13 early checkpoint review unavailability differs from zero queue; direct actions never fake success', async (t) => {
  const h = await webTestApp(t);
  const cookie = h.cookieFor('alice');
  for (const path of ['/review', '/review/1']) {
    const r = await h.get(path, { cookie });
    assert.equal(r.status, 503);
    const text = await r.text();
    assert.match(text, /unavailable/);
    assert.doesNotMatch(text, /No open review items|Accept proposed action|Dismiss without changes/);
  }
  assert.equal(
    (await h.post('/review/1/change', { to: 'company', company: 'Human correction' }, { cookie })).status,
    503,
  );
  assert.equal((await h.post('/review/1/dismiss', {}, { cookie })).status, 503);
  assert.equal((await h.post('/review/1/accept', {}, { cookie })).status, 404);
  assert.equal((await h.post('/settings/accounts/1/chats/1/withdraw', {}, { cookie })).status, 422);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM review_item')?.n, 0);
});

test('Unknown runtime errors remain safe 500 responses rather than unavailable or successful pages', async (t) => {
  const h = await webTestApp(t);
  h.app.pipeline.status = () => {
    throw new Error('Synthetic private provider-error marker');
  };
  const response = await h.get('/board', { cookie: h.cookieFor('alice') });
  assert.equal(response.status, 500);
  const markup = await response.text();
  assert.match(markup, /Internal error/);
  assert.doesNotMatch(markup, /private provider-error marker|No open review items/);
});
