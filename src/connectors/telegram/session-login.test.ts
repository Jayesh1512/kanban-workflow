import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../../contracts/index.ts';
import { readSession, sessionPrefix } from './session-state.ts';
import { deferred, retained, sessionHarness } from './session-test-support.ts';
import { expected, pages } from './test-session.ts';

const token = JSON.stringify({ v: 1, selfId: 10 });
const known = ['u:900', '20:1800000000:0123456789abcdef'] as [string, string];
const saved = (canonical: boolean) =>
  canonical ? sessionPrefix + JSON.stringify({ v: 1, sdkSession: token, keys: [known] }) : token;
const safeFailure = (e: unknown) =>
  e instanceof AppError && e.code === 'invalid' && e.message === 'Connector session persistence failed';
const stopped = (e: unknown) => e instanceof AppError && e.code === 'invalid' && e.message === 'Connector stopped';

test('C1-F6 legacy and canonical restored login export opaque auth and save the latest complete map before done', async () => {
  for (const canonical of [false, true]) {
    const h = sessionHarness(8, saved(canonical));
    const entered = deferred();
    const release = deferred();
    const opaque = 'synthetic opaque\n"\\☃';
    const exported = h.api.exportSession.bind(h.api);
    h.api.exportSession = async () => {
      entered.resolve();
      await release.promise;
      await exported();
      return opaque;
    };
    const imports: string[] = [];
    const importing = h.api.importSession.bind(h.api);
    h.api.importSession = async (value) => {
      imports.push(value);
      await importing(value);
    };
    let done = false;
    const loggingIn = h.connector.login(null).then((step) => {
      done = true;
      return step;
    });
    // Current implementation returns done without entering export, so do not await only entered.
    assert.equal(await Promise.race([entered.promise.then(() => 'export'), loggingIn.then(() => 'done')]), 'export');
    assert.equal(done, false);
    const chat = (await h.connector.listChats())[0]?.chat;
    assert.ok(chat);
    const rows = (await pages(h.connector, { chat, after: null, since: null, limit: null, resume: null })).flatMap(
      (p) => p.messages,
    );
    assert.equal(rows.length, 2);
    const latest = new Map(canonical ? [known] : []);
    for (const row of rows) latest.set(row.nativeId, row.key);
    assert.deepEqual(retained(h.saved.at(-1)), latest);
    assert.equal(done, false);
    release.resolve();
    const step = await loggingIn;
    assert.equal(step.kind, 'done');
    assert.deepEqual(imports, [token]);
    assert.equal(h.api.calls.filter((c) => c.op === 'exportSession').length, 1);
    const envelope = readSession(h.saved.at(-1) as string);
    assert.equal(envelope.sdkSession, opaque);
    assert.deepEqual(envelope.keys, latest);
    assert.equal(h.saved.length, 2); // prospective history save, then mandatory lifecycle save
  }
});

test('C1-F6 legacy and canonical restored login export/save failures reject safely, latch and clean once', async () => {
  for (const canonical of [false, true]) {
    for (const boundary of ['export', 'save'] as const) {
      const h = sessionHarness(1, saved(canonical));
      await h.connector.start(h.sink);
      const handlers = h.handlers();
      let saves = 0;
      h.ctx.saveSession = () => {
        saves++;
        throw new Error('synthetic private callback');
      };
      if (boundary === 'export')
        h.api.exportSession = async () => {
          throw new Error('synthetic private export');
        };
      await assert.rejects(h.connector.login(null), safeFailure);
      assert.equal(saves, boundary === 'export' ? 0 : 1);
      assert.equal(h.saved.length, 0);
      assert.equal(h.api.calls.filter((c) => c.op === 'destroy').length, 1);
      await assert.rejects(h.connector.start(h.sink), safeFailure);
      await assert.rejects(h.connector.listChats(), safeFailure);
      assert.equal(h.api.calls.filter((c) => c.op === 'destroy').length, 1);
      const count = h.events.length;
      const first = h.source.messages[0];
      assert.ok(first);
      await handlers.onNew(first);
      await handlers.onEdit(first);
      handlers.onState('connected');
      await Promise.resolve();
      assert.equal(h.events.length, count);
      assert.ok(h.events.every((e) => e.type === 'status'));
      assert.ok(!JSON.stringify(h.logs).includes('synthetic private'));
    }
  }
});

test('C1-F6 restored login stop/logout during import or getMe cannot save, restore self or report done', async () => {
  for (const boundary of ['importSession', 'getMe'] as const) {
    for (const cancellation of ['stop', 'logout'] as const) {
      const h = sessionHarness(1, saved(true));
      const entered = deferred();
      const release = deferred();
      const importing = h.api.importSession.bind(h.api);
      const getMe = h.api.getMe.bind(h.api);
      if (boundary === 'importSession')
        h.api.importSession = async (value) => {
          entered.resolve();
          await release.promise;
          await importing(value);
        };
      else
        h.api.getMe = async () => {
          const user = await getMe();
          entered.resolve();
          await release.promise;
          return user;
        };
      const loggingIn = h.connector.login(null);
      const outcome = loggingIn.then(
        () => null,
        (e: unknown) => e,
      );
      await entered.promise;
      await h.connector[cancellation]();
      const count = h.saved.length;
      release.resolve();
      assert.ok(stopped(await outcome));
      assert.equal(h.saved.length, count);
      assert.equal(h.api.calls.filter((c) => c.op === 'exportSession').length, 0);
      if (cancellation === 'logout') {
        assert.equal(h.saved.at(-1), null);
        await assert.rejects(h.connector.listChats(), /Login required/);
      } else {
        const imports = h.api.calls.filter((c) => c.op === 'importSession').length;
        const reads = h.api.calls.filter((c) => c.op === 'getMe').length;
        await h.connector.listChats();
        assert.equal(h.api.calls.filter((c) => c.op === 'importSession').length, imports + 1);
        assert.equal(h.api.calls.filter((c) => c.op === 'getMe').length, reads + 1);
      }
      assert.deepEqual(h.events, []);
    }
  }
});

test('C1-F6 restored login canceled during export ignores late value/failure without saving or faulting the next generation', async () => {
  for (const cancellation of ['stop', 'logout'] as const) {
    for (const rejects of [false, true]) {
      const h = sessionHarness(4, saved(true));
      const entered = deferred();
      const release = deferred();
      const exported = h.api.exportSession.bind(h.api);
      let calls = 0;
      h.api.exportSession = async () => {
        if (++calls !== 1) return exported();
        entered.resolve();
        await release.promise;
        if (rejects) throw new Error('synthetic late export');
        return 'synthetic late opaque';
      };
      const loggingIn = h.connector.login(null);
      const outcome = loggingIn.then(
        () => null,
        (e: unknown) => e,
      );
      assert.equal(await Promise.race([entered.promise.then(() => 'export'), outcome.then(() => 'done')]), 'export');
      await h.connector[cancellation]();
      const authoritative = h.saved.at(-1);
      const count = h.saved.length;
      release.resolve();
      assert.ok(stopped(await outcome));
      assert.equal(h.saved.length, count);
      assert.equal(h.saved.at(-1), authoritative);
      if (cancellation === 'logout') {
        assert.equal(authoritative, null);
        assert.equal((await h.connector.login(null)).kind, 'need_input');
      } else {
        assert.deepEqual(retained(authoritative), new Map([known]));
        await h.connector.start(h.sink);
        const first = h.source.messages[0];
        assert.ok(first);
        await h.handlers().onNew(first);
        assert.equal(retained(h.saved.at(-1)).get(expected(first).nativeId), expected(first).key);
        await h.connector.stop();
      }
    }
  }
});

test('C1-F6 cancellation initiated by atomic save prevents false done and preserves logout null or latest stop map', async () => {
  for (const cancellation of ['stop', 'logout'] as const) {
    const h = sessionHarness(0, saved(true));
    const save = h.ctx.saveSession;
    let cancel: Promise<void> | undefined;
    h.ctx.saveSession = (value) => {
      save(value);
      h.ctx.saveSession = save;
      cancel = h.connector[cancellation]();
    };
    await assert.rejects(h.connector.login(null), stopped);
    assert.ok(cancel);
    await cancel;
    if (cancellation === 'logout') {
      assert.equal(h.saved.at(-1), null);
      assert.equal((await h.connector.login(null)).kind, 'need_input');
    } else assert.deepEqual(retained(h.saved.at(-1)), new Map([known]));
  }
});
