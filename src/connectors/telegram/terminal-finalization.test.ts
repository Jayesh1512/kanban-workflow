import assert from 'node:assert/strict';
import test from 'node:test';
import { readSession } from './session-state.ts';
import { credentials, flush, gate, terminalHarness } from './terminal-test-support.ts';
import { expected } from './test-session.ts';

const cancelled = 'Connector logout timed out/cancelled';
const persistence = 'Connector session persistence failed';
const failed = 'Connector logout failed';
const outcome = (work: Promise<void>) =>
  work.then(
    () => null,
    (error: Error) => error,
  );
type Harness = ReturnType<typeof terminalHarness>;

async function fresh(h: Harness) {
  h.useSave((value) => h.saved.push(value));
  await credentials(h.connector);
  const initial = h.saved.at(-1);
  assert.ok(initial);
  assert.equal(readSession(initial).keys.size, 0);
  await h.connector.start(h.sink);
  await h.api.advanceTo('end');
  const messages = h.events.filter((event) => event.type === 'message').map((event) => event.message);
  assert.deepEqual(messages, h.source.messages.map(expected));
  const learned = readSession(h.saved.at(-1) as string).keys;
  assert.equal(learned.size, 4);
  await h.connector.stop(); // Ordinary stop still saves the full latest envelope.
  assert.deepEqual(readSession(h.saved.at(-1) as string).keys, learned);
  const saved = [...h.saved];
  const calls = h.api.calls.length;
  const events = [...h.events];
  await flush();
  assert.deepEqual(h.saved, saved);
  assert.equal(h.api.calls.length, calls);
  assert.deepEqual(h.events, events);
}

async function queued(h: Harness, turns: number, rejects = false) {
  const destroy = h.api.destroy.bind(h.api);
  let repeated: Promise<void> | undefined;
  let stop: Promise<Error | null> | undefined;
  let login: Promise<string> | undefined;
  let callerReacted = false;
  let beforeReaction = false;
  let atCallback: (string | null)[] = [];
  let scheduled = false;
  h.api.destroy = async () => {
    await destroy();
    if (!scheduled) {
      scheduled = true;
      let tail = Promise.resolve();
      for (let n = 0; n < turns; n++) tail = tail.then(() => {});
      void tail.then(() => {
        beforeReaction = !callerReacted;
        atCallback = [...h.saved];
        // Admission and exact shared identity, rather than an unrun caller reaction, define active ownership.
        login = h.connector.login(null).then(
          (step) => step.kind,
          (error: Error) => error.message,
        );
        repeated = h.connector.logout();
        stop = outcome(h.connector.stop());
      });
    }
    if (rejects) throw new Error('private destruction failure');
  };
  const operation = h.connector.logout();
  const result = await outcome(operation).then((error) => {
    callerReacted = true;
    return error;
  });
  await flush();
  assert.ok(repeated);
  assert.ok(stop);
  assert.ok(login);
  const shared = repeated === operation;
  const second = await outcome(repeated);
  const stopped = await stop;
  assert.equal(stopped, second); // One authoritative error object for every admitted waiter.
  assert.equal(await login, shared ? 'Connector stopping' : 'need_input');
  h.api.destroy = destroy;
  return { result, second, shared, beforeReaction, atCallback };
}

for (let turns = 0; turns < 18; turns++) {
  test(`Atomic final handoff ownership / queued position ${turns}`, async (t) => {
    const h = terminalHarness();
    const observed = await queued(h, turns);
    assert.deepEqual(observed.atCallback, [null]);
    assert.equal(h.ctx.now().getTime(), 0);
    assert.equal(h.api.calls.filter((call) => call.op === 'destroy').length, 1);
    if (observed.shared) {
      assert.equal(observed.beforeReaction, true);
      assert.equal(observed.result?.message, cancelled);
      assert.equal(observed.second, observed.result);
      assert.deepEqual(h.saved, [null]); // Exactly once within this ONE shared operation.
    } else {
      assert.equal(observed.result, null);
      assert.equal(observed.second?.message, cancelled);
      assert.deepEqual(h.saved, [null, null]); // Explicit separate logout AFTER legitimate closure.
    }
    t.diagnostic(JSON.stringify({ turns, shared: observed.shared, beforeReaction: observed.beforeReaction }));
    await fresh(h);
  });
}

for (const fault of ['prior-persistence', 'earlier-preparation', 'none'] as const) {
  for (const rejects of [false, true]) {
    test(`Queued-six final handoff / ${fault} / destruction ${rejects ? 'reject' : 'resolve'}`, async (t) => {
      const h = terminalHarness();
      if (fault === 'prior-persistence') {
        await h.connector.listChats();
        h.useSave(() => {
          throw new Error('private first persistence failure');
        });
        await assert.rejects(h.connector.stop(), { message: persistence });
        await flush();
        h.useSave((value) => h.saved.push(value));
      } else if (fault === 'earlier-preparation') {
        h.api.logOut = async () => {
          throw new Error('private earlier preparation failure');
        };
      }
      const observed = await queued(h, 6, rejects);
      const earlier = fault === 'prior-persistence' ? persistence : fault === 'earlier-preparation' ? failed : null;
      // A rejecting destructor at six has already produced its substantive failure before the queued stop.
      assert.equal(
        observed.result?.message ?? null,
        earlier ?? (rejects ? failed : observed.shared ? cancelled : null),
      );
      if (observed.shared) {
        assert.equal(observed.second, observed.result);
        assert.deepEqual(h.saved, [null]);
      } else {
        assert.equal(observed.second?.message, cancelled);
        assert.deepEqual(h.saved, [null, null]);
      }
      t.diagnostic(
        JSON.stringify({ fault, rejects, shared: observed.shared, beforeReaction: observed.beforeReaction }),
      );
      await fresh(h);
    });
  }
}

for (const rejects of [false, true]) {
  test(`True closure fences old finalizers from a NEW held terminal operation / first ${rejects ? 'reject' : 'resolve'}`, async () => {
    const h = terminalHarness();
    const destroy = h.api.destroy.bind(h.api);
    h.api.destroy = async () => {
      await destroy();
      if (rejects) throw new Error('private old cleanup');
    };
    const first = h.connector.logout();
    const firstResult = await outcome(first);
    assert.equal(firstResult?.message ?? null, rejects ? failed : null);
    h.api.destroy = destroy;
    await credentials(h.connector);
    const held = gate();
    h.api.destroy = async () => {
      await destroy();
      await held.promise;
    };
    const second = h.connector.logout();
    const secondResult = outcome(second);
    assert.notEqual(second, first);
    await flush();
    assert.equal(h.connector.logout(), second);
    await assert.rejects(h.connector.login(null), { message: 'Connector stopping' });
    const saved = [...h.saved];
    const stop = outcome(h.connector.stop());
    await flush();
    const result = await secondResult;
    assert.equal(result?.message, cancelled);
    assert.equal(await stop, result);
    h.api.destroy = destroy;
    await credentials(h.connector);
    await h.connector.start(h.sink);
    const newer = [...h.saved];
    const calls = h.api.calls.length;
    const events = [...h.events];
    if (rejects) held.reject(new Error('private detached cleanup'));
    else held.resolve();
    await flush();
    assert.deepEqual(h.saved, newer);
    assert.equal(h.api.calls.length, calls);
    assert.deepEqual(h.events, events);
    assert.equal(saved.filter((value) => value === null).length, 2);
    await h.api.advanceTo('end');
    assert.deepEqual(
      h.events.filter((event) => event.type === 'message').map((event) => event.message),
      h.source.messages.map(expected),
    );
    const learned = readSession(h.saved.at(-1) as string).keys;
    await h.connector.stop();
    assert.deepEqual(readSession(h.saved.at(-1) as string).keys, learned);
  });
}
