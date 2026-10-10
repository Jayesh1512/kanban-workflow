import assert from 'node:assert/strict';
import test from 'node:test';
import { getMessages } from '../index.ts';
import { connect, controlled, deferred, message, setup } from './test-support.ts';

test('inclusion actual log failure rolls back agreement, graph company, chat, selection and syncing queue atomically', async (t) => {
  const r = await controlled(setup());
  t.after(async () => {
    await r.host.stopAll();
    r.h.close();
  });
  await r.control.advanceTo('setup');
  const id = await connect(r.host, r.ctx());
  await r.host.startAll();
  const before = r.h.db.all('SELECT * FROM action_log');
  const run = r.h.db.run.bind(r.h.db);
  r.h.db.run = (sql, ...params) => {
    if (sql.startsWith('INSERT INTO action_log') && params[3] === 'chat.include')
      throw new Error('synthetic include log failure');
    return run(sql, ...params);
  };
  assert.throws(
    () => r.host.includeChat(r.ctx(), id, 'selected', { agreedWordingVersion: 1, company: 'Must roll back' }),
    /synthetic include log failure/,
  );
  assert.deepEqual(r.h.db.all('SELECT * FROM action_log'), before);
  for (const table of ['chat', 'chat_selection', 'chat_agreement', 'account_chat', 'company'])
    assert.equal(r.h.db.all(`SELECT * FROM ${table}`).length, 0);
  await r.host.settle();
  assert.equal(r.control.calls.filter((c) => c.op === 'fetchHistory').length, 0);
  r.h.db.run = run;
});

test('page actual store/log failure rolls back ALL sightings/messages/graph and resume/newest, retains gap until explicit successful retry', async () => {
  for (const failure of ['store', 'log']) {
    const failed = deferred();
    const retry = deferred();
    const r = await controlled(setup(), {
      decorate(c) {
        return {
          ...c,
          async *fetchHistory() {
            yield { messages: [message(1), message(2)], resume: 'synthetic-page' };
          },
        };
      },
      async sleep(ms, h) {
        if (ms >= 60000) await retry.promise;
        else h.clock.advance(ms);
      },
    });
    await r.control.advanceTo('setup');
    const id = await connect(r.host, r.ctx());
    await r.host.startAll();
    const run = r.h.db.run.bind(r.h.db);
    r.h.db.run = (sql, ...params) => {
      if (
        (failure === 'store' && sql.startsWith('INSERT INTO message(') && params[1] === 'key-2') ||
        (failure === 'log' && sql.startsWith('INSERT INTO action_log') && params[3] === 'contact.update')
      )
        throw new Error('synthetic page write failure');
      const result = run(sql, ...params);
      if (sql.includes("sync_state='failed'")) failed.resolve();
      return result;
    };
    r.host.includeChat(r.ctx(), id, 'selected', { agreedWordingVersion: 1, company: null });
    await failed.promise;
    for (const table of ['message', 'message_sighting', 'chat_participant', 'contact'])
      assert.equal(r.h.db.all(`SELECT * FROM ${table}`).length, 0);
    const sync = r.h.db.get<{ sync_state: string; sync_resume: string | null; sync_newest: string | null }>(
      'SELECT * FROM account_chat',
    );
    assert.equal(sync?.sync_state, 'failed');
    assert.equal(sync?.sync_resume, null);
    assert.equal(sync?.sync_newest, null);
    assert.equal(r.host.listAccounts(r.ctx())[0]?.gaps.length, 1);
    r.h.db.run = run;
    retry.resolve();
    await r.host.settle();
    assert.equal(getMessages(r.ctx(), {}).length, 2);
    assert.equal(r.host.listAccounts(r.ctx())[0]?.gaps.length, 0);
    await r.host.stopAll();
    r.h.close();
  }
});
