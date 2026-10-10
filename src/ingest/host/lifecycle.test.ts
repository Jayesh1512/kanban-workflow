import assert from 'node:assert/strict';
import test from 'node:test';
import { open, removeTeammate } from '../../auth/index.ts';
import type { Connector, EventSink } from '../../contracts/index.ts';
import { connect, controlled, deferred, setup } from './test-support.ts';

test('R4.3 bounded logout failure removes access/session immediately; stale old save/null cannot replace a new login', async (t) => {
  let old: Connector | undefined;
  const r = await controlled(setup(), {
    decorate(c) {
      old ??= c;
      return {
        ...c,
        async logout() {
          await new Promise<void>(() => {});
        },
      };
    },
  });
  t.after(async () => {
    await r.host.stopAll();
    r.h.close();
  });
  await r.control.advanceTo('setup');
  const id = await connect(r.host, r.ctx());
  const stale = r.contexts.get(id);
  assert.ok(stale);
  const at = r.h.clock.now().getTime();
  const removal = r.host.disconnect(r.ctx(), id);
  assert.equal(
    r.h.db.get<{ session_sealed: Uint8Array | null }>('SELECT session_sealed FROM channel_account')?.session_sealed,
    null,
  );
  assert.equal(r.h.db.get<{ state: string }>('SELECT state FROM channel_account')?.state, 'removed');
  await assert.rejects(removal, /remote logout failed/);
  assert.ok(r.h.clock.now().getTime() - at < 60000);
  await connect(r.host, r.ctx());
  const sealed = r.h.db.get<{ session_sealed: Uint8Array }>(
    'SELECT session_sealed FROM channel_account',
  )?.session_sealed;
  assert.ok(sealed);
  const saved = open(Buffer.alloc(32, 7), sealed);
  assert.throws(() => stale.saveSession('old session must not revive'), /no longer active/);
  assert.throws(() => stale.saveSession(null), /no longer active/);
  assert.equal(
    open(
      Buffer.alloc(32, 7),
      r.h.db.get<{ session_sealed: Uint8Array }>('SELECT session_sealed FROM channel_account')?.session_sealed ??
        new Uint8Array(),
    ),
    saved,
  );
  assert.ok(old);
  await assert.rejects(old.stop(), /no longer active/); // Fixture invalidates its old delivery before the forbidden stale save.
});

test('reconnect catch-up at most once per five minutes; stop cancels pending reconnect wait and settle is bounded', async (t) => {
  let sink: EventSink | undefined;
  const wait = deferred();
  const sleeping = deferred();
  const r = await controlled(setup(), {
    decorate(c) {
      return {
        ...c,
        async start(s) {
          sink = s;
          await c.start(s);
        },
      };
    },
    async sleep(ms, h) {
      if (ms >= 300000) {
        sleeping.resolve();
        await wait.promise;
      } else h.clock.advance(ms);
    },
  });
  t.after(async () => {
    wait.resolve();
    await r.host.stopAll();
    r.h.close();
  });
  await r.control.advanceTo('setup');
  await connect(r.host, r.ctx());
  await r.host.startAll();
  assert.ok(sink);
  const calls = r.control.calls.length;
  await sink.emit({ type: 'status', state: 'disconnected' });
  await sink.emit({ type: 'status', state: 'connected' });
  await sleeping.promise;
  await sink.emit({ type: 'status', state: 'disconnected' });
  await sink.emit({ type: 'status', state: 'connected' });
  assert.equal(r.control.calls.length, calls);
  await r.host.stopAll();
  await r.host.settle();
  wait.resolve();
  await Promise.resolve();
  assert.equal(r.control.calls.length, calls);
  assert.equal(r.host.chatCounts(r.ctx()).connected, false);
});

test('stop uses the system disconnect boundary for a removed owner without accepting a revoked final save', async (t) => {
  let logouts = 0;
  const r = await controlled(setup(), {
    decorate(c) {
      return {
        ...c,
        async logout() {
          logouts++;
          await c.logout();
        },
      };
    },
  });
  t.after(() => r.h.close());
  await r.control.advanceTo('setup');
  const id = await connect(r.host, r.ctx());
  await r.host.startAll();
  const owner = r.ctx().actor;
  assert.equal(owner.kind, 'teammate');
  assert.ok(r.h.db.get('SELECT session_sealed FROM channel_account WHERE id=?', id));
  await removeTeammate(r.ctx('bob'), owner.kind === 'teammate' ? owner.id : 0, async () => {});
  const stale = r.contexts.get(id);
  assert.ok(stale);
  assert.throws(() => stale.saveSession('revoked final save'), /no longer active/);
  await r.host.stopAll();
  assert.equal(logouts, 1);
  assert.deepEqual(
    {
      ...r.h.db.get<{ state: string; session_sealed: Uint8Array | null }>(
        'SELECT state,session_sealed FROM channel_account WHERE id=?',
        id,
      ),
    },
    {
      state: 'removed',
      session_sealed: null,
    },
  );
  const removed = r.h.db.get<{ id: number }>("SELECT id FROM action_log WHERE action='teammate.remove'");
  const disconnected = r.h.db.get<{ id: number; actor_kind: string }>(
    "SELECT id,actor_kind FROM action_log WHERE action='account.disconnect'",
  );
  assert.ok(removed && disconnected && disconnected.id > removed.id);
  assert.equal(disconnected.actor_kind, 'system');
  assert.throws(() => stale.saveSession(null), /no longer active/);
  await r.host.stopAll();
  assert.equal(logouts, 1);
});
