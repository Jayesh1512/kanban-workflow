import assert from 'node:assert/strict';
import test from 'node:test';
import { readSession } from './session-state.ts';
import { credentials, flush, gate, terminalHarness } from './terminal-test-support.ts';

const cancelled = 'Connector logout timed out/cancelled';
const persistence = 'Connector session persistence failed';
const failed = 'Connector logout failed';
const outcome = (work: Promise<void>) =>
  work.then(
    () => null,
    (error: Error) => error,
  );

async function priorFault(h: ReturnType<typeof terminalHarness>) {
  await h.connector.listChats();
  h.useSave(() => {
    throw new Error('private earlier persistence error');
  });
  await assert.rejects(h.connector.stop(), { message: persistence });
  await flush();
}

async function fresh(h: ReturnType<typeof terminalHarness>) {
  h.useSave((value) => h.saved.push(value));
  await credentials(h.connector);
  await h.connector.stop();
  const saved = h.saved.at(-1);
  assert.ok(saved);
  assert.deepEqual(readSession(saved).keys, new Map());
  const count = h.saved.length;
  await flush();
  assert.equal(h.saved.length, count);
}

for (const fault of ['none', 'prior', 'null-before', 'null-after'] as const) {
  for (const rejects of [false, true]) {
    test(`Final null-callback stop / ${fault} / destruction ${rejects ? 'reject' : 'resolve'}`, async () => {
      const h = terminalHarness();
      if (fault === 'prior') await priorFault(h);
      const original = h.api.destroy.bind(h.api);
      h.api.destroy = async () => {
        await original();
        if (rejects) throw new Error('private later destruction error');
      };
      let nulls = 0;
      let stop: Promise<Error | null> | undefined;
      let repeatedStop: Promise<Error | null> | undefined;
      let repeatedLogout: Promise<void> | undefined;
      const before = h.saved.length;
      h.useSave((value) => {
        assert.equal(value, null);
        nulls++;
        // Destruction is already invoked, but its continuation is not awaited yet.
        assert.equal(h.api.calls.filter((call) => call.op === 'destroy').length, fault === 'prior' ? 2 : 1);
        stop = outcome(h.connector.stop());
        repeatedStop = outcome(h.connector.stop());
        repeatedLogout = h.connector.logout();
        if (fault !== 'null-before') h.saved.push(value);
        if (fault.startsWith('null-')) throw new Error('private null callback error');
      });
      const operation = h.connector.logout();
      const logout = outcome(operation);
      const result = await logout;
      assert.ok(stop);
      assert.ok(repeatedStop);
      const stopped = await stop;
      const stoppedAgain = await repeatedStop;
      assert.equal(repeatedLogout, operation);
      assert.equal(result?.message, fault === 'none' ? cancelled : persistence);
      assert.equal(stopped, result);
      assert.equal(stoppedAgain, result);
      assert.equal(nulls, 1);
      assert.deepEqual(h.saved.slice(before), fault === 'null-before' ? [] : [null]);
      assert.equal(h.ctx.now().getTime(), 0);
      assert.equal(h.api.calls.filter((call) => call.op === 'destroy').length, fault === 'prior' ? 2 : 1);
      h.api.destroy = original;
      // A throwing null retains its authority/fault until an explicit later cleanup.
      if (fault.startsWith('null-')) {
        h.useSave((value) => h.saved.push(value));
        await assert.rejects(h.connector.logout(), { message: persistence });
      }
      await fresh(h);
    });
  }
}

for (const fault of [false, true]) {
  for (const readyFirst of [false, true]) {
    for (const rejects of [false, true]) {
      test(`Final held destruction / prior fault ${fault} / ready first ${readyFirst} / ${rejects ? 'reject' : 'resolve'}`, async () => {
        const h = terminalHarness();
        if (fault) await priorFault(h);
        const held = gate();
        const original = h.api.destroy.bind(h.api);
        h.api.destroy = async () => {
          await original();
          await held.promise;
        };
        const before = h.saved.length;
        h.useSave((value) => h.saved.push(value));
        const operation = h.connector.logout();
        const logout = outcome(operation);
        assert.equal(h.connector.logout(), operation);
        await flush();
        assert.deepEqual(h.saved.slice(before), [null]);
        const settle = () => {
          if (rejects) held.reject(new Error('private final destruction error'));
          else held.resolve();
        };
        // Ready work has not yet resumed its awaited continuation at this boundary.
        if (readyFirst) settle();
        const stop = outcome(h.connector.stop());
        const repeated = outcome(h.connector.stop());
        if (!readyFirst) settle();
        const [result, stopped, again] = await Promise.all([logout, stop, repeated]);
        assert.equal(result?.message, fault ? persistence : cancelled);
        assert.equal(stopped, result);
        assert.equal(again, result);
        assert.deepEqual(h.saved.slice(before), [null]);
        assert.equal(h.api.calls.filter((call) => call.op === 'destroy').length, fault ? 2 : 1);
        assert.equal(h.ctx.now().getTime(), 0);
        h.api.destroy = original;
        await fresh(h);
      });
    }
  }
}

for (const rejects of [false, true]) {
  test(`Final stop settles without waiting; detached old destruction ${rejects ? 'reject' : 'resolve'} is inert`, async () => {
    const h = terminalHarness();
    const held = gate();
    const original = h.api.destroy.bind(h.api);
    h.api.destroy = async () => {
      await original();
      await held.promise;
    };
    let settled = false;
    const operation = h.connector.logout();
    const logout = outcome(operation).then((result) => {
      settled = true;
      return result;
    });
    await flush();
    assert.deepEqual(h.saved, [null]);
    const stop = outcome(h.connector.stop());
    assert.equal(h.connector.logout(), operation);
    await flush();
    const promptly = settled;
    // Drain unchanged defective production too, without real timers or a hanging BEFORE run.
    if (!settled) h.advance(5000);
    const [result, stopped] = await Promise.all([logout, stop]);
    h.api.destroy = original;
    await fresh(h);
    await h.connector.start(h.sink);
    const saved = [...h.saved];
    const calls = h.api.calls.length;
    const events = [...h.events];
    if (rejects) held.reject(new Error('private detached destruction error'));
    else held.resolve();
    await flush();
    assert.deepEqual(h.saved, saved);
    assert.equal(h.api.calls.length, calls);
    assert.deepEqual(h.events, events);
    await h.api.advanceTo('end');
    assert.ok(h.events.some((event) => event.type === 'message'));
    await h.connector.stop();
    assert.equal(promptly, true);
    assert.equal(result?.message, cancelled);
    assert.equal(stopped, result);
    assert.equal(h.saved.filter((value) => value === null).length, 1);
    assert.equal(h.ctx.now().getTime(), 0);
  });
}

test('First preparation failure retains precedence when final null callback stops cleanup', async () => {
  const h = terminalHarness();
  h.api.logOut = async () => {
    throw new Error('private earlier RPC failure');
  };
  let stop: Promise<Error | null> | undefined;
  h.useSave((value) => {
    assert.equal(value, null);
    h.saved.push(value);
    stop = outcome(h.connector.stop());
  });
  const result = await outcome(h.connector.logout());
  assert.ok(stop);
  assert.equal(result?.message, failed);
  assert.equal(await stop, result);
  assert.deepEqual(h.saved, [null]);
  await fresh(h);
});
