import assert from 'node:assert/strict';
import test from 'node:test';
import { credentials, flush, gate, terminalHarness } from './terminal-test-support.ts';

test('Pending credential login phone/code/password late resolve/reject never reports done or persists after teardown', async () => {
  for (const boundary of ['sendCode', 'signIn', 'checkPassword'] as const) {
    for (const rejects of [false, true]) {
      const h = terminalHarness(null);
      await h.connector.login(null);
      if (boundary !== 'sendCode') await h.connector.login({ phone: '+10000000000' });
      if (boundary === 'checkPassword') {
        h.api.signIn = async () => 'password_needed';
        await h.connector.login({ code: '12345' });
      }
      const held = gate();
      const entered = gate();
      if (boundary === 'sendCode') {
        const original = h.api.sendCode.bind(h.api);
        h.api.sendCode = async (value) => {
          const result = await original(value);
          entered.resolve();
          await held.promise;
          return result;
        };
      } else if (boundary === 'signIn') {
        const original = h.api.signIn.bind(h.api);
        h.api.signIn = async (value) => {
          const result = await original(value);
          entered.resolve();
          await held.promise;
          return result;
        };
      } else {
        const original = h.api.checkPassword.bind(h.api);
        h.api.checkPassword = async (value) => {
          const result = await original(value);
          entered.resolve();
          await held.promise;
          return result;
        };
      }
      const input: Record<string, string> =
        boundary === 'sendCode'
          ? { phone: '+10000000000' }
          : boundary === 'signIn'
            ? { code: '12345' }
            : { password: 'synthetic-password' };
      const pending = h.connector.login(input);
      await entered.promise;
      await h.connector.logout();
      if (rejects) held.reject(new Error('private old login'));
      else held.resolve();
      assert.equal((await pending).kind, 'failed');
      assert.deepEqual(h.saved, [null]);
      assert.equal((await h.connector.login(null)).kind, 'need_input');
      assert.ok(!JSON.stringify(h.logs).includes('private old login'));
    }
  }
});

test('An older blocked sink rejecting after fresh startup cannot destroy or disconnect the new generation', async () => {
  const h = terminalHarness(null);
  await credentials(h.connector);
  let handlers: Parameters<typeof h.api.startUpdates>[0] | null = null;
  const updates = h.api.startUpdates.bind(h.api);
  h.api.startUpdates = async (value) => {
    handlers = value;
    await updates(value);
  };
  const held = gate();
  const entered = gate();
  await h.connector.start({
    async emit(event) {
      if (event.type === 'message') {
        entered.resolve();
        await held.promise;
      }
    },
  });
  assert.ok(handlers);
  const old = handlers as Parameters<typeof h.api.startUpdates>[0];
  const first = h.source.messages[0];
  assert.ok(first);
  const delivery = old.onNew(first);
  const rejection = assert.rejects(delivery, /private old sink/);
  await entered.promise;
  await h.connector.logout();
  await credentials(h.connector);
  await h.connector.start(h.sink);
  const destroyed = h.api.calls.filter((c) => c.op === 'destroy').length;
  held.reject(new Error('private old sink'));
  await rejection;
  await flush();
  assert.equal(h.api.calls.filter((c) => c.op === 'destroy').length, destroyed);
  assert.ok(handlers);
  const second = h.source.messages[1];
  assert.ok(second);
  await (handlers as Parameters<typeof h.api.startUpdates>[0]).onNew(second);
  assert.equal(h.events.filter((e) => e.type === 'message').length, 1);
});

for (const rejects of [false, true]) {
  test(`Pending history late ${rejects ? 'reject' : 'resolve'} cannot acknowledge a page or learn keys after barrier`, async () => {
    const h = terminalHarness();
    const chat = (await h.connector.listChats())[0]?.chat;
    assert.ok(chat);
    h.advance(3000);
    const original = h.api.history.bind(h.api);
    const held = gate();
    const entered = gate();
    h.api.history = async (peer, options) => {
      const result = await original(peer, options);
      entered.resolve();
      await held.promise;
      return result;
    };
    const iterator = h.connector
      .fetchHistory({ chat, after: null, since: null, limit: null, resume: null })
      [Symbol.asyncIterator]();
    const page = iterator.next();
    const outcome = assert.rejects(page, rejects ? /private history/ : /Connector stopped/);
    await entered.promise;
    await h.connector.logout();
    await credentials(h.connector);
    const count = h.saved.length;
    if (rejects) held.reject(new Error('private history'));
    else held.resolve();
    await outcome;
    assert.equal(h.saved.length, count);
    assert.equal((await h.connector.login(null)).kind, 'done');
  });
}
