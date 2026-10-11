import assert from 'node:assert/strict';
import test from 'node:test';
import { within } from './terminal-logout.ts';
import { credentials, flush, safePersistence, safeTimeout, terminalHarness } from './terminal-test-support.ts';

for (const microtask of [false, true]) {
  for (const rejects of [false, true]) {
    for (const elapsed of [4999, 5000, 5001, 50001]) {
      test(`F9 cleanup ${microtask ? 'microtask' : 'ready'} ${rejects ? 'reject' : 'success'} at ${elapsed}ms`, async () => {
        const h = terminalHarness();
        const destroy = h.api.destroy.bind(h.api);
        let nullBeforeWait = false;
        h.api.destroy = async () => {
          await destroy();
          if (microtask) await Promise.resolve();
          h.advance(elapsed);
          nullBeforeWait = h.saved.at(-1) === null;
          if (rejects) throw new Error('PRIVATE cleanup');
        };
        const logout = h.connector.logout();
        if (elapsed >= 5000) await assert.rejects(logout, safeTimeout);
        else if (rejects) await assert.rejects(logout, /Connector logout failed/);
        else await logout;
        // Synchronous null is scheduled before awaiting cleanup, including expired success.
        assert.deepEqual(h.saved, [null]);
        if (microtask) assert.ok(nullBeforeWait);
        assert.equal(h.ctx.now().getTime(), elapsed);
        assert.equal(h.api.calls.filter((c) => c.op === 'destroy').length, 1);
        h.api.destroy = destroy;
        await credentials(h.connector);
        const count = h.saved.length;
        await flush();
        assert.equal(h.saved.length, count);
        assert.equal((await h.connector.login(null)).kind, 'done');
      });
    }
  }
}

for (const elapsed of [49998, 49999, 50000, 50001]) {
  test(`F9 final method-entry budget at ${elapsed}ms includes 44999ms preparation`, async () => {
    const h = terminalHarness();
    const importing = h.api.importSession.bind(h.api);
    h.api.importSession = async (value) => {
      await importing(value);
      h.advance(44999);
    };
    const destroy = h.api.destroy.bind(h.api);
    h.api.destroy = async () => {
      await Promise.resolve();
      await destroy();
      h.advance(elapsed - 44999);
    };
    if (elapsed === 49998) await h.connector.logout();
    else await assert.rejects(h.connector.logout(), safeTimeout);
    assert.deepEqual(h.saved, [null]);
    assert.equal(h.ctx.now().getTime(), elapsed);
  });
}

for (const boundary of ['importSession', 'logOut'] as const) {
  for (const rejects of [false, true]) {
    for (const elapsed of [44999, 45000, 45001]) {
      test(`F9 ${boundary} ${rejects ? 'reject' : 'success'} completion at ${elapsed}ms`, async () => {
        const h = terminalHarness();
        const original = h.api[boundary].bind(h.api);
        h.api[boundary] = async (...args: [string] | []) => {
          await Promise.resolve();
          h.advance(elapsed);
          if (rejects) throw new Error('PRIVATE preparation');
          if (args.length) await (original as (value: string) => Promise<void>)(args[0]);
          else await (original as () => Promise<void>)();
        };
        if (elapsed >= 45000) await assert.rejects(h.connector.logout(), safeTimeout);
        else if (rejects) await assert.rejects(h.connector.logout(), /Connector logout failed/);
        else await h.connector.logout();
        assert.deepEqual(h.saved, [null]);
        if (boundary === 'importSession' && (rejects || elapsed >= 45000))
          assert.equal(h.api.calls.filter((c) => c.op === 'logOut').length, 0);
      });
    }
  }
}

test('F9 already fulfilled/rejected work cannot bypass an expired absolute clock', async () => {
  const h = terminalHarness(null);
  h.advance(5000);
  await assert.rejects(within(h.ctx, 5000, Promise.resolve()), safeTimeout);
  await assert.rejects(within(h.ctx, 5000, Promise.reject(new Error('PRIVATE'))), safeTimeout);
});

test('F9 first admitted persistence failure wins over cleanup crossing the final deadline', async () => {
  const h = terminalHarness();
  const destroy = h.api.destroy.bind(h.api);
  h.api.destroy = async () => {
    await Promise.resolve();
    h.advance(50001);
    await destroy();
  };
  h.useSave((value) => {
    if (value !== null) throw new Error('PRIVATE persistence');
    h.saved.push(null);
  });
  await assert.rejects(h.connector.login(null), safePersistence);
  await assert.rejects(h.connector.logout(), safePersistence);
  assert.deepEqual(h.saved, [null]);
});

for (const rejects of [false, true]) {
  for (const elapsed of [49999, 50000, 50001]) {
    test(`F9 whole 50s bound on already-ready ${rejects ? 'rejection' : 'success'} at ${elapsed}ms`, async () => {
      const h = terminalHarness(null);
      h.advance(elapsed);
      const work = rejects ? Promise.reject(new Error('PRIVATE')) : Promise.resolve();
      if (elapsed >= 50000) await assert.rejects(within(h.ctx, 50000, work), safeTimeout);
      else if (rejects) await assert.rejects(within(h.ctx, 50000, work), /PRIVATE/);
      else await within(h.ctx, 50000, work);
    });
  }
}
