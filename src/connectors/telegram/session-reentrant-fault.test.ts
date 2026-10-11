import assert from 'node:assert/strict';
import test from 'node:test';
import type { TelegramApi } from '../../contracts/index.ts';
import { readSession } from './session-state.ts';
import { credentials, flush, gate, safePersistence, terminalHarness } from './terminal-test-support.ts';

for (const action of ['stop', 'logout'] as const) {
  for (const committed of [false, true]) {
    for (const boundary of ['restored login', 'live key', 'pending startup', 'history page'] as const) {
      test(`F7 ${boundary}: ${action} then ${committed ? 'commit and throw' : 'throw before commit'} preserves fault`, async () => {
        const h = terminalHarness();
        let handlers: Parameters<TelegramApi['startUpdates']>[0] | null = null;
        const started = gate();
        const pending = gate();
        h.api.startUpdates = async (value) => {
          handlers = value;
          started.resolve();
          if (boundary === 'pending startup') await pending.promise;
        };
        let startup: Promise<void> | null = null;
        let startupFault: Promise<string> | null = null;
        if (boundary === 'pending startup') {
          startup = h.connector.start(h.sink);
          startupFault = startup.then(
            () => 'resolved',
            (e: Error) => e.message,
          );
          await started.promise;
        } else if (boundary === 'live key') await h.connector.start(h.sink);
        const authoritative = h.ctx.session;
        let external = authoritative;
        let attempted: string | null = null;
        let termination: Promise<void> | null = null;
        let terminalFault: Promise<string> | null = null;
        let attempts = 0;
        h.useSave((value) => {
          attempts++;
          if (attempts === 1 && value !== null) {
            attempted = value;
            if (committed) external = value;
            termination = h.connector[action]();
            terminalFault = termination.then(
              () => 'resolved',
              (e: Error) => e.message,
            );
            throw new Error('PRIVATE atomic replacement error');
          }
          external = value;
          h.saved.push(value);
        });
        const first = h.source.messages[0];
        assert.ok(first);
        let work: Promise<unknown>;
        if (boundary === 'restored login') work = h.connector.login(null);
        else if (boundary === 'history page') {
          const [chat] = await h.connector.listChats();
          assert.ok(chat);
          h.advance(3000);
          const iterator = h.connector.fetchHistory({
            chat: chat.chat,
            after: null,
            since: null,
            limit: 100,
            resume: null,
          });
          work = iterator[Symbol.asyncIterator]().next();
        } else {
          assert.ok(handlers);
          work = (handlers as Parameters<TelegramApi['startUpdates']>[0]).onNew(first);
        }
        const result = await work.then(
          () => 'resolved',
          (e: Error) => e.message,
        );
        assert.ok(termination && terminalFault);
        const ended = await terminalFault;
        if (startupFault) {
          // The old awaiting boundary still fails after successful null and a NEW successful login.
          if (action === 'logout') await credentials(h.connector);
          pending.resolve();
          const startResult = await startupFault;
          assert.match(startResult, safePersistence);
        }
        assert.match(result, safePersistence);
        assert.match(ended, safePersistence);
        assert.equal(h.events.filter((e) => e.type === 'message' || e.type === 'edit').length, 0);
        if (action === 'logout') {
          assert.ok(h.saved.includes(null));
          if (!startupFault) await credentials(h.connector);
          assert.equal((await h.connector.login(null)).kind, 'done');
          assert.equal(readSession(h.saved.at(-1) as string).keys.size, 0);
        } else {
          await assert.rejects(h.connector.login(null), safePersistence);
          assert.equal(h.saved.length, 0); // No automatic retry or successful stop save.
          assert.equal(external, committed ? attempted : authoritative);
        }
        const count = h.saved.length;
        if (handlers) {
          await (handlers as Parameters<TelegramApi['startUpdates']>[0]).onNew(first);
          (handlers as Parameters<TelegramApi['startUpdates']>[0]).onState('connected');
        }
        await flush();
        assert.equal(h.saved.length, count);
        assert.equal(h.events.filter((e) => e.type === 'message' || e.type === 'edit').length, 0);
        assert.ok(!JSON.stringify(h.logs).includes('PRIVATE'));
      });
    }
  }
}

for (const action of ['stop', 'logout'] as const) {
  for (const boundary of ['credential login', 'ordinary stop'] as const) {
    test(`F7 ${boundary} reentrant throwing ${action} callback fails both lifecycle boundaries`, async () => {
      const h = terminalHarness(boundary === 'credential login' ? null : 'canonical');
      if (boundary === 'credential login') {
        await h.connector.login(null);
        await h.connector.login({ phone: '+10000000000' });
      } else await h.connector.login(null);
      let ended: Promise<string> | null = null;
      let attempts = 0;
      h.useSave((value) => {
        if (value !== null && ++attempts === 1) {
          ended = h.connector[action]().then(
            () => 'resolved',
            (e: Error) => e.message,
          );
          throw new Error('PRIVATE callback');
        }
        h.saved.push(value);
      });
      const work = boundary === 'credential login' ? h.connector.login({ code: '12345' }) : h.connector.stop();
      const outcome = await work.then(
        () => 'resolved',
        (e: Error) => e.message,
      );
      assert.ok(ended);
      assert.match(await ended, safePersistence);
      assert.match(outcome, safePersistence);
      assert.equal(attempts, 1);
      if (action === 'stop') await assert.rejects(h.connector.logout(), safePersistence);
      assert.equal(h.saved.at(-1), null);
      h.useSave((value) => h.saved.push(value));
      await credentials(h.connector);
      assert.equal((await h.connector.login(null)).kind, 'done');
      assert.equal(readSession(h.saved.at(-1) as string).keys.size, 0);
    });
  }
}
