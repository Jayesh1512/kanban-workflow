import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../../contracts/index.ts';
import { createSessionState } from './session-state.ts';
import { deferred, retained, sessionHarness } from './session-test-support.ts';
import { expected, login, pages } from './test-session.ts';

const safeFailure = (e: unknown) =>
  e instanceof AppError && e.code === 'invalid' && e.message === 'Connector session persistence failed';

test('C1-F1 atomic callback failure prevents acknowledgment, latches live delivery, retains candidate and has fixed safe error', async () => {
  const h = sessionHarness();
  await login(h.connector);
  await h.connector.start(h.sink);
  const before = h.saved.at(-1);
  let attempts = 0;
  h.ctx.saveSession = () => {
    attempts++;
    throw new Error('synthetic-private-payload');
  };
  const first = h.source.messages[0];
  const next = h.source.messages[1];
  assert.ok(first && next);
  await assert.rejects(h.handlers().onNew(first), safeFailure);
  await h.handlers().onNew(next);
  assert.equal(attempts, 1);
  assert.equal(h.saved.at(-1), before);
  assert.deepEqual(
    h.events.map((e) => (e.type === 'status' ? e.state : e.type)),
    ['connected', 'disconnected'],
  );
  await assert.rejects(h.connector.listChats(), safeFailure);
  await assert.rejects(h.connector.stop(), safeFailure);
  assert.ok(!JSON.stringify(h.logs).includes('synthetic-private-payload'));
  assert.ok(h.api.calls.some((c) => c.op === 'destroy'));
  // The private failed snapshot remains complete until explicit recreation; no automatic retry/re-key.
  const state = sessionHarness();
  let failures = 0;
  const privateState = createSessionState(
    {
      ...state.ctx,
      session: before as string,
      saveSession() {
        throw new Error('synthetic');
      },
    },
    state.api,
    async () => {
      failures++;
    },
  );
  await assert.rejects(
    privateState.learn([first], () => true),
    safeFailure,
  );
  assert.equal(privateState.failedCandidate()?.get(expected(first).nativeId), expected(first).key);
  assert.equal(failures, 1);
});

test('C1-F1 save precedes delivery: failed insertion/crash replay uses the saved key for an edited first observation', async () => {
  const h = sessionHarness(1);
  await login(h.connector);
  const first = h.source.messages[0];
  assert.ok(first);
  await h.connector.start({
    async emit(event) {
      if (event.type === 'message') {
        assert.equal(retained(h.saved.at(-1)).get(event.message.nativeId), event.message.key);
        throw new Error('synthetic-crash-before-insertion');
      }
    },
  });
  await assert.rejects(h.handlers().onNew(first), /synthetic-crash-before-insertion/);
  const restored = sessionHarness(1, h.saved.at(-1) as string);
  await restored.connector.start(restored.sink);
  await restored.handlers().onEdit({ ...first, text: 'Synthetic edited', editDate: first.date + 1 });
  const event = restored.events.find((e) => e.type === 'edit');
  assert.ok(event?.type === 'edit');
  assert.equal(event.message.key, expected(first).key);
  assert.equal(event.message.text, 'Synthetic edited');
  await restored.connector.stop();
});

test('C1-F1 commit-then-throw acknowledges nothing; recreation from authoritative atomic new state preserves the candidate', async () => {
  const h = sessionHarness(1);
  await login(h.connector);
  await h.connector.start(h.sink);
  let authoritative = h.saved.at(-1) as string;
  h.ctx.saveSession = (value) => {
    authoritative = value as string;
    throw new Error('synthetic ambiguous commit');
  };
  const original = h.source.messages[0];
  assert.ok(original);
  await assert.rejects(h.handlers().onNew(original), safeFailure);
  assert.ok(h.events.every((e) => e.type === 'status'));
  const restored = sessionHarness(1, authoritative);
  await restored.connector.start(restored.sink);
  await restored.handlers().onEdit({ ...original, text: 'Synthetic new revision', editDate: original.date + 1 });
  const edit = restored.events.find((e) => e.type === 'edit');
  assert.ok(edit?.type === 'edit');
  assert.equal(edit.message.key, expected(original).key);
  await restored.connector.stop();
});

test('C1-F1 history saves a whole prospective page once before yield; failed later page preserves prior resume', async () => {
  const h = sessionHarness(120);
  const peer = { type: 'user', id: 20 } as const;
  h.source.messages = h.source.messages.map((m) => ({ ...m, peer }));
  // Recreate the port from this dedicated source; original 220-message interruption remains separately active.
  const { RecordedApi } = await import('./recorded-api.ts');
  const { createTelegramFactory } = await import('./connector.ts');
  const api = new RecordedApi({ session: h.source }, h.ctx.now);
  const connector = createTelegramFactory(() => api).create(h.ctx);
  await login(connector);
  const chat = (await connector.listChats())[0]?.chat;
  assert.ok(chat);
  const req = { chat, after: null, since: null, limit: null, resume: null };
  const iterator = connector.fetchHistory(req)[Symbol.asyncIterator]();
  const page = (await iterator.next()).value;
  assert.ok(page?.resume);
  assert.equal(page.messages.length, 100);
  assert.equal(h.saved.length, 2);
  assert.equal(retained(h.saved.at(-1)).size, 100);
  for (const row of page.messages) assert.equal(retained(h.saved.at(-1)).get(row.nativeId), row.key);
  const authoritative = h.saved.at(-1) as string;
  h.ctx.saveSession = () => {
    throw new Error('synthetic page save failure');
  };
  await assert.rejects(iterator.next(), safeFailure);
  assert.equal(h.saved.at(-1), authoritative);
  const next = sessionHarness(0, authoritative);
  const freshApi = new RecordedApi({ session: h.source }, next.ctx.now);
  const fresh = createTelegramFactory(() => freshApi).create(next.ctx);
  const rest = await pages(fresh, { ...req, resume: page.resume });
  assert.equal(rest.flatMap((p) => p.messages).length, 20);
  assert.equal(retained(next.saved.at(-1)).size, 120);
  assert.equal(freshApi.calls.filter((c) => c.op === 'history')[0]?.maxId, 21);
  await fresh.stop();
});

test('C1-F1 asynchronous stop export plus history learning retains keys already delivered live saves the latest complete map with no extra RPC', async () => {
  const h = sessionHarness(8);
  await login(h.connector);
  await h.connector.start(h.sink);
  const entered = deferred();
  const release = deferred();
  const exportSession = h.api.exportSession.bind(h.api);
  h.api.exportSession = async () => {
    entered.resolve();
    await release.promise;
    return exportSession();
  };
  // A stop export is deliberately in flight while history adds to a key learned live.
  const first = h.source.messages[0];
  assert.ok(first);
  await h.handlers().onNew(first);
  const saving = h.connector.stop();
  await entered.promise;
  const chat = (await h.connector.listChats())[1]?.chat;
  assert.ok(chat);
  await pages(h.connector, { chat, after: null, since: null, limit: null, resume: null });
  assert.equal(retained(h.saved.at(-1)).size, 3);
  release.resolve();
  await saving;
  assert.equal(retained(h.saved.at(-1)).size, 3);
  assert.equal(h.api.calls.filter((c) => c.op === 'exportSession').length, 2); // login and explicit lifecycle save only
  await h.connector.start(h.sink);
  const count = h.saved.length;
  await h.handlers().onEdit({ ...first, text: 'Synthetic changed', editDate: first.date + 1 });
  await h.handlers().onNew({ ...first, peer: { type: 'channel', id: 50 } });
  await h.handlers().onNew({ ...first, id: 999, isService: true });
  await h.handlers().onDelete({ ids: [first.id], channelId: null });
  assert.equal(h.saved.length, count);
  await h.connector.stop();
  assert.equal(retained(h.saved.at(-1)).size, 3); // no deletion/stop eviction
});

test('C1-F1 export and serialization failures cannot report login/stop success or leak payloads', async (t) => {
  for (const boundary of ['login', 'stop'] as const) {
    const h = sessionHarness();
    if (boundary === 'stop') await login(h.connector);
    h.api.exportSession = async () => {
      throw new Error('synthetic-private-export');
    };
    if (boundary === 'login') {
      await h.connector.login(null);
      await h.connector.login({ phone: '+10000000000' });
      await assert.rejects(h.connector.login({ code: '12345' }), safeFailure);
    } else await assert.rejects(h.connector.stop(), safeFailure);
    assert.ok(!JSON.stringify(h.logs).includes('synthetic-private-export'));
  }
  const h = sessionHarness();
  await login(h.connector);
  await h.connector.start(h.sink);
  const stringify = JSON.stringify;
  t.mock.method(JSON, 'stringify', (value: unknown) => {
    if (value && typeof value === 'object' && 'sdkSession' in value)
      throw new Error('synthetic serialization exhaustion');
    return stringify(value);
  });
  const first = h.source.messages[0];
  assert.ok(first);
  await assert.rejects(h.handlers().onNew(first), safeFailure);
  assert.ok(h.events.every((e) => e.type === 'status'));
  assert.equal(h.saved.length, 1);
});

test('C1-F1 serialized pending export cannot overwrite concurrent live-sized and history-sized key learning', async () => {
  const h = sessionHarness(12, JSON.stringify({ v: 1, selfId: 10 }));
  await h.api.importSession(h.ctx.session as string);
  const entered = deferred();
  const release = deferred();
  const exported = h.api.exportSession.bind(h.api);
  h.api.exportSession = async () => {
    entered.resolve();
    await release.promise;
    return exported();
  };
  const state = createSessionState(h.ctx, h.api, async () => assert.fail('unexpected failure'));
  state.restore();
  const saving = state.save();
  await entered.promise;
  const first = h.source.messages[0];
  assert.ok(first);
  const page = h.source.messages.filter((m) => m.peer.type === 'group');
  const [live, history] = await Promise.all([state.learn([first], () => true), state.learn(page, () => true)]);
  assert.deepEqual(live, [expected(first)]);
  assert.deepEqual(history, page.map(expected));
  assert.equal(retained(h.saved.at(-1)).size, 4);
  release.resolve();
  await saving;
  assert.equal(retained(h.saved.at(-1)).size, 4);
  assert.equal(h.api.calls.filter((c) => c.op === 'exportSession').length, 1);
});

test('C1-F1 an export completing after successful logout cannot resurrect session or keys', async () => {
  const h = sessionHarness(1);
  await login(h.connector);
  await h.connector.start(h.sink);
  const first = h.source.messages[0];
  assert.ok(first);
  await h.handlers().onNew(first);
  const entered = deferred();
  const release = deferred();
  h.api.exportSession = async () => {
    entered.resolve();
    await release.promise;
    return JSON.stringify({ v: 1, selfId: 10 });
  };
  const stopping = h.connector.stop();
  const rejection = assert.rejects(stopping, /Connector stopped/);
  await entered.promise;
  await h.connector.logout();
  assert.equal(h.saved.at(-1), null);
  release.resolve();
  await rejection;
  assert.equal(h.saved.at(-1), null);
  await assert.rejects(h.connector.listChats(), /Login required/);
});

test('C1-F1 history save failure aborts without waiting for a blocked live sink; queued notifications cannot run after stop', async () => {
  const h = sessionHarness(4);
  await login(h.connector);
  const entered = deferred();
  const release = deferred();
  const seen: string[] = [];
  await h.connector.start({
    async emit(event) {
      seen.push(event.type);
      if (event.type === 'message') {
        entered.resolve();
        await release.promise;
      }
    },
  });
  const first = h.source.messages[0];
  assert.ok(first);
  const live = h.handlers().onNew(first);
  await entered.promise;
  const chat = (await h.connector.listChats())[1]?.chat;
  assert.ok(chat);
  h.ctx.saveSession = () => {
    throw new Error('synthetic history failure');
  };
  await assert.rejects(pages(h.connector, { chat, after: null, since: null, limit: null, resume: null }), safeFailure);
  assert.ok(h.api.calls.some((c) => c.op === 'destroy'));
  const count = seen.length;
  release.resolve();
  await live;
  assert.equal(seen.length, count);
});
