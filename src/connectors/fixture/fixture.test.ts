import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { FixtureLine, HistoryPage, MessageRecord } from '../../contracts/index.ts';
import { testContext } from '../test-support.ts';
import { createFixtureConnector } from './index.ts';

const chat = { key: 'chat', nativeId: 'chat', kind: 'direct' as const, title: 'Synthetic chat' };
function message(n: number): MessageRecord {
  return {
    key: `key-${n}`,
    nativeId: `native-${n}`,
    cursor: String(n).padStart(4, '0'),
    sender: { userKey: 'outside', displayName: 'Synthetic sender', handle: null },
    sentAt: new Date(1800000000000 + n * 1000).toISOString(),
    text: `Synthetic message ${n}`,
    media: n === 2 ? 'voice' : null,
    replyToNativeId: n === 2 ? 'native-1' : null,
    editedAt: null,
  };
}
function recording(): FixtureLine[] {
  return [
    { t: 'config', pageSize: 2 },
    { t: 'account', account: 'alice', self: { userKey: 'self', displayName: 'Synthetic owner', handle: 'owner' } },
    { t: 'mark', name: 'before-chat' },
    { t: 'chat', account: 'alice', chat },
    { t: 'message', account: 'alice', chatKey: 'chat', delivery: 'history', message: message(1) },
    { t: 'mark', name: 'before-live' },
    { t: 'message', account: 'alice', chatKey: 'chat', delivery: 'live', message: message(2) },
    { t: 'message', account: 'alice', chatKey: 'chat', delivery: 'missed', message: message(3) },
    { t: 'message', account: 'alice', chatKey: 'chat', delivery: 'missed', message: message(4) },
    { t: 'history_error', account: 'alice', chatKey: 'chat', afterPages: 1, times: 1 },
    { t: 'mark', name: 'interrupt' },
    {
      t: 'edit',
      account: 'alice',
      chatKey: 'chat',
      message: { ...message(2), key: 'recomputed-wrong', text: 'Synthetic edited', editedAt: message(5).sentAt },
    },
    { t: 'delete', account: 'alice', nativeIds: ['native-1'], deletedAt: message(5).sentAt },
    { t: 'mark', name: 'edited' },
    { t: 'message', account: 'alice', chatKey: 'chat', delivery: 'live', message: message(5) },
  ];
}
const request = { chat, after: null, since: null, limit: null, resume: null };
test('R7 fixture controlled login/list/marks/live/missed/history/error/resume/edit/delete/null logout', async () => {
  const { factory, control } = createFixtureConnector({ lines: recording() });
  const state = testContext();
  const connector = factory.create(state.ctx);
  assert.equal(factory.loginNotice({}), null);
  assert.deepEqual(factory.capabilities, { history: true, edits: true, deletions: true });
  assert.equal((await connector.login(null)).kind, 'need_input');
  assert.equal((await connector.login({ account: 'missing' })).kind, 'failed');
  assert.equal((await connector.login({ account: 'alice' })).kind, 'done');
  await control.advanceTo('before-chat');
  assert.deepEqual(await connector.listChats(), []);
  await control.advanceTo('before-live');
  assert.equal((await connector.listChats())[0]?.latestCursor, '0001');
  await connector.start(state.sink);
  await control.advanceTo('interrupt');
  assert.deepEqual(
    state.events.filter((e) => e.type === 'message').map((e) => e.message),
    [message(2)],
  );
  assert.equal((await connector.listChats())[0]?.latestCursor, '0004');
  const yielded: HistoryPage[] = [];
  await assert.rejects(async () => {
    for await (const page of connector.fetchHistory(request)) yielded.push(page);
  }, /Synthetic history failure/);
  assert.deepEqual(
    yielded[0]?.messages.map((m) => m.cursor),
    ['0004', '0003'],
  );
  const restored = factory.create(testContext(state.saved[0] as string).ctx);
  const continued: HistoryPage[] = [];
  const firstPage = yielded[0];
  assert.ok(firstPage);
  for await (const page of restored.fetchHistory({ ...request, resume: firstPage.resume })) continued.push(page);
  assert.deepEqual(
    continued.flatMap((p) => p.messages.map((m) => m.cursor)),
    ['0002', '0001'],
  );
  assert.equal(continued.at(-1)?.resume, null);
  await assert.rejects(async () => {
    for await (const _ of connector.fetchHistory({ ...request, after: '0001', resume: firstPage.resume })) {
    }
  }, /resume token/);
  await control.advanceTo('edited');
  const edit = state.events.find((e) => e.type === 'edit');
  assert.ok(edit?.type === 'edit');
  assert.equal(edit.message.key, message(2).key);
  assert.ok(state.events.some((e) => e.type === 'delete'));
  const filtered: MessageRecord[] = [];
  for await (const page of connector.fetchHistory({ ...request, after: '0001', since: message(3).sentAt, limit: 1 }))
    filtered.push(...page.messages);
  assert.deepEqual(
    filtered.map((m) => m.cursor),
    ['0004'],
  );
  await connector.stop();
  const count = state.events.length;
  await control.advanceTo('end');
  assert.equal(state.events.length, count);
  await connector.logout();
  assert.equal(state.saved.at(-1), null);
  await assert.rejects(connector.listChats(), /login required/);
  assert.ok(control.calls.every((c) => c.account === 'alice' && ['listChats', 'fetchHistory'].includes(c.op)));
});

test('Fixture path source and independent replay/account instances do not share state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'connector-fixture-'));
  try {
    const path = join(dir, 'recording.jsonl');
    writeFileSync(
      path,
      recording()
        .map((l) => JSON.stringify(l))
        .join('\n'),
    );
    const one = createFixtureConnector({ path });
    const two = createFixtureConnector({ lines: recording() });
    const a = testContext('alice');
    const b = testContext('alice');
    const first = one.factory.create(a.ctx);
    const second = two.factory.create(b.ctx);
    await first.start(a.sink);
    await second.start(b.sink);
    await one.control.advanceTo('before-live');
    assert.equal((await first.listChats()).length, 1);
    assert.equal((await second.listChats()).length, 0);
    assert.equal(two.control.calls.length, 1);
    await one.control.advanceTo('interrupt');
    await first.stop();
    const thirdState = testContext('alice', 2);
    const third = one.factory.create(thirdState.ctx);
    await third.start(thirdState.sink);
    await one.control.advanceTo('end');
    assert.equal(a.events.filter((e) => e.type === 'edit').length, 0);
    assert.equal(thirdState.events.filter((e) => e.type === 'edit').length, 1);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('Fixture delivery awaits sink, cancels later calls after stop and disconnects rejecting sink', async () => {
  const fixture = createFixtureConnector({ lines: recording() });
  const state = testContext('alice');
  const connector = fixture.factory.create(state.ctx);
  let release: () => void = () => {};
  let enter: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await connector.start({
    async emit(event) {
      state.events.push(event);
      if (event.type === 'message') {
        enter();
        await pending;
      }
    },
  });
  const replay = fixture.control.advanceTo('end');
  await entered;
  await connector.stop();
  const count = state.events.length;
  release();
  await replay;
  assert.equal(state.events.length, count);
  const failing = createFixtureConnector({ lines: recording() });
  const other = failing.factory.create(testContext('alice').ctx);
  const types: string[] = [];
  await other.start({
    async emit(event) {
      types.push(event.type === 'status' ? event.state : event.type);
      if (event.type === 'message') throw new Error('Synthetic reject');
    },
  });
  await assert.rejects(failing.control.advanceTo('end'), /Synthetic reject/);
  await failing.control.advanceTo('end');
  assert.deepEqual(types, ['connected', 'message', 'disconnected']);
});

test('Fixture errors before first page repeat and invalid input/marks are rejected', async () => {
  const lines = recording().slice(0, 6);
  lines.push({ t: 'history_error', account: 'alice', chatKey: 'chat', afterPages: 0 });
  const fixture = createFixtureConnector({ lines });
  const connector = fixture.factory.create(testContext('alice').ctx);
  await fixture.control.advanceTo('end');
  for (let n = 0; n < 2; n++)
    await assert.rejects(async () => {
      for await (const _ of connector.fetchHistory(request)) {
      }
    }, /Synthetic history failure/);
  await assert.rejects(fixture.control.advanceTo('missing'), /Unknown or passed/);
  assert.throws(() => createFixtureConnector({ lines: [{ t: 'config', pageSize: 101 }] }), /page size/);
});

test('Fixture newest cursor metadata survives deletion', async () => {
  const lines = recording().slice(0, 6);
  lines.push({ t: 'delete', account: 'alice', nativeIds: ['native-1'], deletedAt: message(2).sentAt });
  const fixture = createFixtureConnector({ lines });
  const state = testContext('alice');
  const connector = fixture.factory.create(state.ctx);
  await fixture.control.advanceTo('end');
  assert.equal((await connector.listChats())[0]?.latestCursor, '0001');
  const result: HistoryPage[] = [];
  for await (const page of connector.fetchHistory(request)) result.push(page);
  assert.deepEqual(result, [{ messages: [], resume: null }]);
});
