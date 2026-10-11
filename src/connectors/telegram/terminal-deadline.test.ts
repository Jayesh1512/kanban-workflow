import assert from 'node:assert/strict';
import test from 'node:test';
import { credentials, flush, gate, safePersistence, safeTimeout, terminalHarness } from './terminal-test-support.ts';

for (const rejects of [false, true]) {
  test(`Absolute entry deadline fences late import ${rejects ? 'rejection' : 'resolution'} and fresh generation`, async () => {
    const h = terminalHarness();
    const pending = gate();
    const importing = h.api.importSession.bind(h.api);
    let first = true;
    h.api.importSession = async (value) => {
      if (first) {
        first = false;
        await pending.promise;
      }
      await importing(value);
    };
    const logout = h.connector.logout();
    const outcome = assert.rejects(logout, safeTimeout);
    await flush();
    assert.ok(h.waits.some((w) => w.end === 45000));
    assert.deepEqual(h.saved, []);
    h.advance(45000);
    await outcome;
    assert.deepEqual(h.saved, [null]);
    assert.equal(h.api.calls.filter((c) => c.op === 'logOut').length, 0);
    assert.equal(h.api.calls.filter((c) => c.op === 'destroy').length, 1);
    await credentials(h.connector);
    const count = h.saved.length;
    if (rejects) pending.reject(new Error('private late import'));
    else pending.resolve();
    await flush();
    assert.equal(h.saved.length, count);
    assert.equal(h.api.calls.filter((c) => c.op === 'logOut').length, 0);
    assert.equal((await h.connector.login(null)).kind, 'done');
  });
}

for (const boundary of ['logOut', 'destroy'] as const) {
  for (const rejects of [false, true]) {
    test(`Held ${boundary} late ${rejects ? 'reject' : 'resolve'} cannot clear a newer saved generation`, async () => {
      const h = terminalHarness();
      const pending = gate();
      const original = h.api[boundary].bind(h.api);
      h.api[boundary] = async () => {
        await original();
        await pending.promise;
      };
      const logout = h.connector.logout();
      const outcome = assert.rejects(logout, safeTimeout);
      await flush();
      if (boundary === 'destroy') assert.deepEqual(h.saved, [null]); // Null precedes any wait on destruction.
      h.advance(boundary === 'logOut' ? 45000 : 5000);
      await outcome;
      assert.deepEqual(h.saved, [null]);
      h.api[boundary] = original;
      await credentials(h.connector);
      const count = h.saved.length;
      if (rejects) pending.reject(new Error('private held failure'));
      else pending.resolve();
      await flush();
      assert.equal(h.saved.length, count);
      assert.equal((await h.connector.login(null)).kind, 'done');
    });
  }
}

test('Prior five-second fault cleanup consumes preparation, null runs before held destruction; first fault wins', async () => {
  const h = terminalHarness(null);
  await credentials(h.connector);
  let handlers: Parameters<typeof h.api.startUpdates>[0] | null = null;
  const start = h.api.startUpdates.bind(h.api);
  h.api.startUpdates = async (value) => {
    handlers = value;
    await start(value);
  };
  await h.connector.start(h.sink);
  const prior = gate();
  const destroy = h.api.destroy.bind(h.api);
  h.api.destroy = async () => {
    await destroy();
    await prior.promise;
  };
  h.useSave((value) => {
    if (value !== null) throw new Error('private write failure');
    h.saved.push(null);
  });
  assert.ok(handlers);
  const first = h.source.messages[0];
  assert.ok(first);
  const delivery = handlers as Parameters<typeof h.api.startUpdates>[0];
  await assert.rejects(delivery.onNew(first), safePersistence);
  const logout = h.connector.logout();
  const outcome = assert.rejects(logout, safePersistence);
  await flush();
  h.advance(5000);
  prior.resolve();
  const imported = gate();
  h.api.importSession = async () => {
    await imported.promise;
  };
  await flush();
  assert.equal(h.api.calls.filter((c) => c.op === 'logOut').length, 0);
  h.advance(40000);
  await flush();
  assert.deepEqual(h.saved.at(-1), null);
  h.advance(5000);
  await outcome;
  assert.equal(h.ctx.now().getTime(), 50000);
  imported.reject(new Error('late import'));
  await flush();
});

test('Repeated logout shares original operation and stop cancels without nonnull save or deadline reset', async () => {
  const h = terminalHarness();
  const pending = gate();
  h.api.importSession = async () => pending.promise;
  const first = h.connector.logout();
  assert.equal(h.connector.logout(), first);
  const failure = assert.rejects(first, safeTimeout);
  await flush();
  h.advance(12000);
  const stopped = assert.rejects(h.connector.stop(), safeTimeout);
  await Promise.all([failure, stopped]);
  assert.deepEqual(h.saved, [null]);
  assert.equal(h.api.calls.filter((c) => c.op === 'destroy').length, 1);
  assert.equal(h.api.calls.filter((c) => c.op === 'logOut').length, 0);
  pending.resolve();
  await flush();
});
