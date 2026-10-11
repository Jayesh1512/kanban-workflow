import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../../contracts/index.ts';
import { createSessionState, readSession } from './session-state.ts';
import { credentials, flush, gate, safePersistence, terminalHarness } from './terminal-test-support.ts';

for (const stopped of [false, true]) {
  test(`Logout uses ${stopped ? 'stopped restored' : 'current connected'} auth, no getMe/export/lifecycle resave`, async () => {
    const h = terminalHarness();
    await h.connector.start(h.sink);
    if (stopped) await h.connector.stop();
    const before = h.api.calls.length;
    await h.connector.logout();
    const calls = h.api.calls.slice(before).map((c) => c.op);
    assert.deepEqual(calls, stopped ? ['importSession', 'logOut', 'destroy'] : ['logOut', 'destroy']);
    assert.equal(h.saved.at(-1), null);
  });
}

for (const boundary of ['importSession', 'logOut', 'destroy'] as const) {
  test(`Logout ${boundary} failure is safe, still attempts exactly one local null`, async () => {
    const h = terminalHarness();
    h.api[boundary] = async () => {
      throw new Error('PRIVATE SDK session details');
    };
    await assert.rejects(h.connector.logout(), (e) => e instanceof AppError && e.message === 'Connector logout failed');
    assert.deepEqual(h.saved, [null]);
    assert.ok(!JSON.stringify(h.logs).includes('PRIVATE'));
  });
}

test('Failed nonnull candidate never replaces latest saved authority or first safe persistence fault', async () => {
  const h = terminalHarness(null);
  await credentials(h.connector);
  const authoritative = h.saved.at(-1);
  assert.equal(typeof authoritative, 'string');
  const old = readSession(authoritative as string).sdkSession;
  h.api.exportSession = async () => ` ${old} `;
  const cleanup = gate();
  const destroy = h.api.destroy.bind(h.api);
  h.api.destroy = async () => {
    await destroy();
    await cleanup.promise;
  };
  h.useSave((value) => {
    if (value !== null) throw new Error('private persistence');
    h.saved.push(null);
  });
  await assert.rejects(h.connector.login(null), safePersistence);
  let imported: string | null = null;
  const importSession = h.api.importSession.bind(h.api);
  h.api.importSession = async (value) => {
    imported = value;
    await importSession(value);
  };
  const logout = h.connector.logout();
  const outcome = assert.rejects(logout, safePersistence);
  await flush();
  assert.equal(imported, null);
  cleanup.resolve();
  await outcome;
  assert.equal(imported, old);
  assert.deepEqual(h.saved, [authoritative, null]);
});

test('Synchronous lane records authority and failed candidate before separately held failure cleanup', async () => {
  const h = terminalHarness(null);
  const held = gate();
  const first = h.source.messages[0];
  assert.ok(first);
  const sessions = createSessionState(h.ctx, h.api, () => held.promise);
  await h.api.importSession(h.opaque);
  await sessions.save();
  const old = h.saved.at(-1);
  h.useSave(() => {
    throw new Error('private');
  });
  await assert.rejects(
    sessions.learn([first], () => true),
    safePersistence,
  );
  assert.ok(sessions.failedCandidate()?.size === 1);
  const snapshot = sessions.barrier();
  assert.equal(snapshot.saved, old);
  assert.match(snapshot.error?.message ?? '', safePersistence);
  assert.ok(snapshot.cleanup);
  held.reject(new Error('late cleanup rejection'));
  await flush();
});

test('Null callback failure preserves saved authority, first fault, and no automatic retry', async () => {
  const h = terminalHarness();
  let attempts = 0;
  h.useSave(() => {
    attempts++;
    throw new Error('PRIVATE null');
  });
  await assert.rejects(h.connector.logout(), safePersistence);
  assert.equal(attempts, 1);
  await assert.rejects(h.connector.login(null), safePersistence);
  assert.equal(attempts, 1);
  assert.deepEqual(h.saved, []);
});

for (const action of ['logout', 'stop'] as const) {
  test(`Reentrant save callback ${action} fences queued key installs and lifecycle done`, async () => {
    const h = terminalHarness();
    const loggingIn = h.connector.login(null);
    await loggingIn;
    const old = h.saved.at(-1);
    let termination: Promise<void> | null = null;
    let once = true;
    h.useSave((value) => {
      h.saved.push(value);
      if (once && value !== null) {
        once = false;
        termination = h.connector[action]();
      }
    });
    const result = h.connector.login(null);
    await assert.rejects(result, /Connector stopped/);
    assert.ok(termination);
    await termination;
    if (action === 'logout') assert.equal(h.saved.at(-1), null);
    else assert.equal(readSession(h.saved.at(-1) as string).sdkSession, readSession(old as string).sdkSession);
    const count = h.saved.length;
    await flush();
    assert.equal(h.saved.length, count);
  });
}

for (const rejects of [false, true]) {
  test(`Pending lifecycle export late ${rejects ? 'reject' : 'resolve'} cannot relatch or overwrite fresh auth`, async () => {
    const h = terminalHarness();
    const exportGate = gate<string>();
    const exportSession = h.api.exportSession.bind(h.api);
    h.api.exportSession = async () => exportGate.promise;
    const login = h.connector.login(null);
    const cancelled = assert.rejects(login, /Connector stopped/);
    await flush();
    await h.connector.logout();
    h.api.exportSession = exportSession;
    await credentials(h.connector);
    const count = h.saved.length;
    if (rejects) exportGate.reject(new Error('private old export'));
    else exportGate.resolve(h.opaque);
    await cancelled;
    assert.equal(h.saved.length, count);
    assert.equal((await h.connector.login(null)).kind, 'done');
  });
}

test('An older pending startup retains its substantive persistence fault after terminal null clears current health', async () => {
  const h = terminalHarness(null);
  await credentials(h.connector);
  const entered = gate();
  const held = gate();
  let handlers: Parameters<typeof h.api.startUpdates>[0] | null = null;
  h.api.startUpdates = async (value) => {
    handlers = value;
    entered.resolve();
    await held.promise;
  };
  const start = h.connector.start(h.sink);
  const fault = assert.rejects(start, safePersistence);
  await entered.promise;
  h.useSave((value) => {
    if (value !== null) throw new Error('private fault');
    h.saved.push(null);
  });
  assert.ok(handlers);
  const first = h.source.messages[0];
  assert.ok(first);
  await assert.rejects((handlers as Parameters<typeof h.api.startUpdates>[0]).onNew(first), safePersistence);
  await assert.rejects(h.connector.logout(), safePersistence);
  held.resolve();
  await fault;
  h.useSave((value) => h.saved.push(value));
  await credentials(h.connector);
  assert.equal((await h.connector.login(null)).kind, 'done');
});

for (const action of ['logout', 'stop'] as const) {
  test(`Queued prospective keys and reentrant ${action} cannot install old maps or invoke later saves`, async () => {
    const h = terminalHarness(null);
    await h.api.importSession(h.opaque);
    let termination: Promise<void> | null = null;
    const sessions = createSessionState(h.ctx, h.api, async () => {});
    await sessions.save();
    const initial = h.saved.at(-1);
    const first = h.source.messages[0];
    const second = h.source.messages[1];
    assert.ok(first && second);
    let writes = 0;
    h.useSave((value) => {
      writes++;
      h.saved.push(value);
      if (value !== null) {
        if (action === 'logout') {
          sessions.barrier();
          termination = sessions.clear();
        } else sessions.invalidate();
      }
    });
    const learning = sessions.learn([first], () => true);
    const queued = sessions.learn([second], () => true);
    await assert.rejects(learning, /Connector stopped/);
    await assert.rejects(queued, /Connector stopped/);
    if (termination) await termination;
    assert.equal(writes, action === 'logout' ? 2 : 1);
    assert.equal(sessions.failedCandidate(), null);
    if (action === 'logout') {
      sessions.finish();
      assert.equal(sessions.opaque(), null);
    } else {
      const snapshot = sessions.barrier();
      assert.equal(snapshot.saved, initial);
      assert.equal(readSession(snapshot.saved as string).keys.size, 0);
    }
  });
}
