import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { spineRecording } from '../../test/fixtures/spine.ts';
import { testApp } from '../../test/harness.ts';
import { disabledModel, webTestApp } from './testing.ts';

// A minimal event/element boundary exercises the shipped enhancement without a browser
// or an alternate implementation of its filtering rules.
class Element {
  hidden = false;
  value = '';
  textContent = '';
  focused = false;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, () => void>();
  children = new Map<string, Element[]>();
  querySelector(selector: string): Element | null {
    return this.children.get(selector)?.[0] ?? null;
  }
  querySelectorAll(selector: string): Element[] {
    return this.children.get(selector) ?? [];
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  addEventListener(name: string, listener: () => void): void {
    this.listeners.set(name, listener);
  }
  emit(name: string): void {
    const listener = this.listeners.get(name);
    assert.ok(listener, `Enhancement must attach ${name}`);
    listener();
  }
  focus(): void {
    this.focused = true;
  }
}
async function filterFixture(attached = true) {
  const selection = new Element();
  const tools = new Element();
  tools.hidden = true;
  const search = new Element();
  const results = new Element();
  const noMatches = new Element();
  noMatches.hidden = true;
  const reset = new Element();
  const filters = ['all', 'included', 'not-included'].map((value) => {
    const button = new Element();
    button.dataset.chatFilter = value;
    return button;
  });
  const rows = [
    ['Acme integration', 'true'],
    ['Excluded ＡＣＭＥ', 'false'],
    ['Withdrawn <img src=x onerror="sentinel">', 'false'],
    ['Undecided 東京', 'false'],
  ].map(([text = '', included = 'false']) => {
    const row = new Element();
    row.dataset.chatIncluded = included;
    const title = new Element();
    title.textContent = text;
    row.children.set('[data-chat-title]', [title]);
    return row;
  });
  for (const [selector, node] of [
    ['[data-chat-tools]', tools],
    ['[data-chat-search]', search],
    ['[data-chat-results]', results],
    ['[data-chat-no-matches]', noMatches],
    ['[data-chat-reset]', reset],
  ] as const)
    selection.children.set(selector, [node]);
  selection.children.set('[data-chat-filter]', filters);
  selection.children.set('[data-chat-row]', rows);
  if (!attached) selection.children.delete('[data-chat-reset]');
  const script = await readFile(new URL('./static/app.js', import.meta.url), 'utf8');
  runInNewContext(script, {
    document: {
      querySelectorAll: (selector: string) => (selector === '[data-chat-selection]' ? [selection] : []),
      querySelector: () => null,
      getElementById: () => null,
    },
    window: { addEventListener() {} },
    location: { hash: '' },
  });
  const click = (value: string) => {
    const button = filters.find((filter) => filter.dataset.chatFilter === value);
    assert.ok(button);
    button.emit('click');
  };
  const visible = () => rows.map((row, index) => (!row.hidden ? index : -1)).filter((index) => index !== -1);
  return { tools, search, results, noMatches, reset, filters, rows, click, visible };
}

test('Accounts local search composes title matching with all/included/not-included and announces accurate results', async () => {
  const f = await filterFixture();
  assert.equal(f.tools.hidden, false);
  assert.deepEqual(f.visible(), [0, 1, 2, 3]);
  assert.equal(f.results.textContent, 'Showing 4 of 4 chats');
  f.click('included');
  assert.deepEqual(f.visible(), [0]);
  assert.equal(f.results.textContent, 'Showing 1 of 4 chats');
  assert.deepEqual(
    f.filters.map((button) => button.attributes.get('aria-pressed')),
    ['false', 'true', 'false'],
  );
  f.search.value = '  aCmE  ';
  f.search.emit('input');
  assert.deepEqual(f.visible(), [0]);
  f.click('not-included');
  assert.deepEqual(f.visible(), [1]);
  assert.equal(f.results.textContent, 'Showing 1 of 4 chats');
  f.click('all');
  assert.deepEqual(f.visible(), [0, 1]);
  assert.equal(f.noMatches.hidden, true);
});

test('Accounts zero matches, reset focus, literal markup and Unicode titles never need HTML or network access', async () => {
  const f = await filterFixture();
  f.click('included');
  f.search.value = 'no such chat';
  f.search.emit('input');
  assert.deepEqual(f.visible(), []);
  assert.equal(f.noMatches.hidden, false);
  assert.equal(f.results.textContent, 'Showing 0 of 4 chats');
  f.reset.emit('click');
  assert.deepEqual(f.visible(), [0, 1, 2, 3]);
  assert.equal(f.noMatches.hidden, true);
  assert.equal(f.search.value, '');
  assert.equal(f.search.focused, true);
  assert.deepEqual(
    f.filters.map((button) => button.attributes.get('aria-pressed')),
    ['true', 'false', 'false'],
  );
  f.search.value = '<img src=x onerror="sentinel">';
  f.search.emit('input');
  assert.deepEqual(f.visible(), [2]);
  f.search.value = '東京';
  f.search.emit('input');
  assert.deepEqual(f.visible(), [3]);
});

test('Accounts enhancement leaves every chat visible and controls hidden if attachment cannot complete', async () => {
  const f = await filterFixture(false);
  assert.equal(f.tools.hidden, true);
  assert.deepEqual(f.visible(), [0, 1, 2, 3]);
  assert.equal(f.search.listeners.size, 0);
});

test('Accounts native HTML hides enhancement tools, escapes long identities and keeps guarded real forms usable', async (t) => {
  const lines = spineRecording();
  const title = 'Long title <img src=x onerror="sentinel"> & conversation';
  for (const line of lines) if (line.t === 'chat' && line.chat.key === 'excluded') line.chat.title = title;
  const h = await testApp({
    model: disabledModel(),
    lines,
    teammates: [{ username: 'alice', account: 'alice' }, { username: 'jordan' }],
  });
  t.after(async () => {
    await h.app.stop();
    h.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await h.control.advanceTo('setup');
  await h.app.start();
  const account = h.app.host.listAccounts(h.ctxFor('alice'))[0];
  assert.ok(account);
  const cookie = h.cookieFor('alice');
  const connections = await (await h.get('/settings/accounts', { cookie })).text();
  assert.match(connections, /Synthetic fixture/);
  assert.match(connections, /<span class="connection-avatar" aria-hidden="true">/);
  assert.match(connections, /<details class="account-management"><summary>Disconnect account<\/summary>/);
  const path = `/settings/accounts/${account.id}/chats`;
  const response = await h.get(path, { cookie });
  assert.equal(response.status, 200);
  const page = await response.text();
  assert.match(page, /data-chat-tools hidden/);
  assert.match(page, /data-chat-no-matches hidden/);
  assert.match(page, /Long title &lt;img src=x onerror=&quot;sentinel&quot;&gt; &amp; conversation/);
  assert.doesNotMatch(page, /<script>sentinel|<img src=x|Please integrate|handle the invoice/);
  assert.equal((page.match(/data-chat-row /g) ?? []).length, 2);
  assert.doesNotMatch(page, /data-chat-row[^>]* hidden/);
  assert.match(page, /<summary>Include chat<\/summary><form method="post"/);
  assert.match(page, /name="company"/);
  assert.doesNotMatch(page, /name="agreedWordingVersion"|The people in this chat have agreed/);
  assert.equal((await h.get(path, { cookie: h.cookieFor('jordan') })).status, 403);
  assert.equal(
    (await h.post(`${path}/include`, { chatKey: 'excluded', company: '', agreedWordingVersion: '1' }, { cookie }))
      .status,
    303,
  );
  const included = await (await h.get(path, { cookie })).text();
  assert.match(included, /1 of 2 chats included/);
  assert.match(included, /data-chat-included="true"/);
  assert.match(included, /<summary>Withdraw chat and delete imported data<\/summary>/);
  assert.match(included, /App-wide cleanup: across OTHER chats too/);
  assert.match(included, /name="confirm" value="withdraw" required/);
  assert.equal((await h.post(`${path}/exclude`, { chatKey: 'excluded' }, { cookie })).status, 303);
  assert.match(await (await h.get(path, { cookie })).text(), /0 of 2 chats included/);
});

test('Accounts first-use connection disclosure is open natively and has no inert chat filters', async (t) => {
  const h = await webTestApp(t);
  const response = await h.get('/settings/accounts', { cookie: h.cookieFor('alice') });
  assert.equal(response.status, 200);
  const page = await response.text();
  assert.match(page, /No accounts connected yet/);
  assert.match(page, /<details id="connect-account" open>/);
  assert.match(page, /<summary>Connect an account<\/summary>/);
  assert.match(page, /action="\/settings\/accounts" class="connection-form"/);
  assert.doesNotMatch(page, /data-chat-tools/);
});

test('Accounts actual login progress, failed input, retry and disconnect keep truthful status and native controls', async (t) => {
  const h = await webTestApp(t, true);
  await h.control.advanceTo('setup');
  const cookie = h.cookieFor('alice');
  const fields = { channel: 'fixture', acknowledgedNoticeVersion: '' };
  assert.equal((await h.post('/settings/accounts', fields, { cookie })).status, 303);
  const account = h.app.host.listAccounts(h.ctxFor('alice'))[0];
  assert.ok(account);
  const progress = await (await h.get('/settings/accounts', { cookie })).text();
  assert.match(progress, /data-account-state="login">Connection in progress/);
  assert.match(progress, /name="account" type="text" autocomplete="off" required/);
  assert.equal(
    (await h.post(`/settings/accounts/${account.id}/login`, { account: 'missing-fixture' }, { cookie })).status,
    303,
  );
  const failed = await (await h.get('/settings/accounts', { cookie })).text();
  assert.match(failed, /data-account-state="failed">Connection failed/);
  assert.match(failed, /role="alert">Account login failed/);
  assert.match(failed, /Start the connection again to retry/);
  assert.equal((await h.post('/settings/accounts', fields, { cookie })).status, 303);
  assert.equal((await h.post(`/settings/accounts/${account.id}/login`, { account: 'alice' }, { cookie })).status, 303);
  assert.match(
    await (await h.get('/settings/accounts', { cookie })).text(),
    /data-account-state="connected">Connected/,
  );
  assert.equal((await h.post(`/settings/accounts/${account.id}/disconnect`, {}, { cookie })).status, 422);
  assert.equal(
    (await h.post(`/settings/accounts/${account.id}/disconnect`, { confirm: 'on' }, { cookie })).status,
    303,
  );
  const removed = await (await h.get('/settings/accounts', { cookie })).text();
  assert.match(removed, /data-account-state="removed">Disconnected/);
  assert.match(removed, /Connect an account again to choose chats/);
  assert.doesNotMatch(removed, new RegExp(`href="/settings/accounts/${account.id}/chats"`));
});
