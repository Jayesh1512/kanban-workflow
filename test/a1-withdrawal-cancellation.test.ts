import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createApp } from '../src/app.ts';
import { addTeammate, removeTeammate, signIn } from '../src/auth/index.ts';
import { attachMessage, createCard, createLane, getBoard } from '../src/board/index.ts';
import { loadConfig } from '../src/config.ts';
import { createFixtureConnector } from '../src/connectors/fixture/index.ts';
import type {
  ConnectorFactory,
  Ctx,
  DecideInput,
  FixtureLine,
  Model,
  MovementRequest,
  MovementResult,
} from '../src/contracts/index.ts';
import { AppError } from '../src/contracts/index.ts';
import { getMessages } from '../src/ingest/index.ts';
import { openDb } from '../src/store/index.ts';

type Mode = 'GENERAL' | 'MOVEMENT';
function gate<T>(): {
  response: PromiseWithResolvers<T>;
  entered: PromiseWithResolvers<void>;
  signal: AbortSignal | undefined;
} {
  const response = Promise.withResolvers<T>();
  const entered = Promise.withResolvers<void>();
  return { response, entered, signal: undefined };
}
function stay(request: MovementRequest): MovementResult {
  const evidence = request.evidenceOptions[0];
  assert.ok(evidence);
  return {
    provider: 'jev',
    execution: 'replay',
    configuredModel: null,
    providerRequestId: null,
    schemaVersion: 1,
    requestId: request.requestId,
    snapshotHash: request.snapshotHash,
    kind: 'answered',
    resolvedModel: null,
    movement: { choice: 'stay', confidence: 1, probabilities: { stay: 1 } },
    support: { choice: evidence.id, confidence: 1, probabilities: { [evidence.id]: 1 } },
    supportTarget: 'stay',
    supportQuestionId: 'support:stay',
    usage: null,
  };
}
function lines(shared: boolean): FixtureLine[] {
  const owners = shared ? ['alice', 'bob'] : ['alice'];
  return [
    ...owners.flatMap((account): FixtureLine[] => [
      { t: 'account', account, self: { userKey: `self-${account}`, displayName: account, handle: null } },
      ...['selected', 'unrelated'].map(
        (key): FixtureLine => ({
          t: 'chat',
          account,
          chat: { key, nativeId: key, kind: 'group', title: `Synthetic ${key}` },
        }),
      ),
    ]),
    { t: 'mark', name: 'setup' },
    ...['selected', 'unrelated'].map(
      (chatKey, i): FixtureLine => ({
        t: 'message',
        account: 'alice',
        delivery: 'live',
        chatKey,
        message: {
          key: `message-${chatKey}`,
          nativeId: `native-${chatKey}`,
          cursor: `000${i + 1}`,
          sender: { userKey: 'outside', displayName: 'Outside', handle: null },
          sentAt: `2026-09-01T10:00:0${i + 1}.000Z`,
          text: `Synthetic ${chatKey} evidence`,
          media: null,
          replyToNativeId: null,
          editedAt: null,
        },
      }),
    ),
    { t: 'mark', name: 'delivered' },
    {
      t: 'message',
      account: 'alice',
      delivery: 'live',
      chatKey: 'selected',
      message: {
        key: 'new-selected',
        nativeId: 'new-selected',
        cursor: '0003',
        sender: { userKey: 'outside', displayName: 'Outside', handle: null },
        sentAt: '2026-09-01T10:00:03.000Z',
        text: 'New authentic generation',
        media: null,
        replyToNativeId: null,
        editedAt: null,
      },
    },
    { t: 'mark', name: 'new-delivered' },
  ];
}
async function scenario(
  mode: Mode,
  options: {
    shared?: boolean;
    abortReject?: boolean;
    remoteHold?: boolean;
    invokeError?: AppError;
    sharedModel?: Model;
    generalGate?: ReturnType<typeof gate<unknown>>;
  } = {},
) {
  const consumer = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  console.log(
    'FIRST_EXACT_APP',
    JSON.stringify({ identity: randomUUID(), memory: true, handles: 0, olderWriters: 0, consumer }),
  );
  const db = openDb(':memory:');
  const fixture = createFixtureConnector({ lines: lines(options.shared ?? false) });
  const general = options.generalGate ?? gate<unknown>();
  const movement = gate<MovementResult>();
  const logout = gate<void>();
  const inputs: DecideInput[] = [];
  const requests: MovementRequest[] = [];
  let stops = 0;
  const connectorFactory: ConnectorFactory = {
    ...fixture.factory,
    create(ctx) {
      const connector = fixture.factory.create(ctx);
      return {
        ...connector,
        async stop() {
          stops++;
          await connector.stop();
        },
        async logout() {
          if (options.remoteHold) {
            logout.entered.resolve();
            await logout.response.promise;
          }
          await connector.logout();
        },
      };
    },
  };
  const now = () => new Date('2026-09-01T10:00:00.000Z');
  const config = loadConfig({
    KANBAN_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
    CONNECTORS: 'fixture',
    MODEL_PROVIDER: 'disabled',
  });
  const system: Ctx = { db, now, actor: { kind: 'system' }, canReadText: true };
  const contexts = new Map<string, Ctx>();
  for (const username of options.shared ? ['alice', 'bob'] : ['alice']) {
    const id = addTeammate(system, { username, displayName: username, password: 'synthetic-password' });
    contexts.set(username, { ...system, actor: { kind: 'teammate', id } });
  }
  const ctx = contexts.get('alice');
  assert.ok(ctx);
  const lane = createLane(ctx, {
    name: 'Sales',
    sop: 'Synthetic sales',
    stages: [
      { name: 'New', criteria: '' },
      { name: 'Done', criteria: 'Complete' },
    ],
  });
  createLane(ctx, {
    name: 'Finance',
    sop: 'Synthetic finance',
    stages: [
      { name: 'Received', criteria: '' },
      { name: 'Paid', criteria: 'Paid' },
    ],
  });
  const decision = {
    disposition: 'create',
    cardId: null,
    proposalId: null,
    laneId: lane.id,
    title: 'Synthetic card',
    summary: 'Synthetic summary.',
    cardCompanyId: null,
    cardCompanyName: null,
    confidence: 1,
    reason: 'Synthetic SOP',
    move: null,
    contacts: [],
    mentions: [],
  };
  const model: Model = options.sharedModel ?? {
    name: 'opaque-synthetic',
    endpointHost: null,
    blocked: null,
    decide(input, signal) {
      inputs.push(input);
      if (options.invokeError && mode === 'GENERAL') throw options.invokeError;
      if (mode === 'GENERAL' && inputs.length === 1) {
        general.signal = signal;
        general.entered.resolve();
        if (options.abortReject)
          signal.addEventListener('abort', () => general.response.reject(new DOMException('Aborted', 'AbortError')), {
            once: true,
          });
        return general.response.promise;
      }
      return Promise.resolve(decision);
    },
  };
  const app = createApp({
    db,
    config,
    model,
    movement: {
      decide(request, signal) {
        requests.push(request);
        if (options.invokeError && mode === 'MOVEMENT') throw options.invokeError;
        if (mode === 'MOVEMENT' && requests.length === 1) {
          movement.signal = signal;
          movement.entered.resolve();
          if (options.abortReject)
            signal.addEventListener(
              'abort',
              () => movement.response.reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          return movement.response.promise;
        }
        return Promise.resolve(stay(request));
      },
      status: () => ({
        provider: 'jev',
        execution: 'replay',
        state: 'ready',
        reason: null,
        endpointHost: null,
        model: null,
      }),
    },
    connectors: [connectorFactory],
    now,
    async sleep(ms) {
      // Controlled declared wait boundary. No cleanup deadline elapses unless the test advances it.
      if (ms >= 5000) await new Promise<void>(() => {});
      else await new Promise<void>((resolve) => setImmediate(resolve));
    },
    oplog() {},
  });
  const accounts = new Map<string, number>();
  try {
    await fixture.control.advanceTo('setup');
    for (const [username, owner] of contexts) {
      const login = await app.host.beginLogin(owner, 'fixture', { acknowledgedNoticeVersion: null });
      assert.equal((await app.host.continueLogin(owner, login.accountId, { account: username })).kind, 'done');
      accounts.set(username, login.accountId);
    }
    await app.host.startAll();
    for (const [username, owner] of contexts) {
      const account = accounts.get(username);
      assert.ok(account);
      await app.host.listChats(owner, account);
      for (const key of ['selected', 'unrelated'])
        app.host.includeChat(owner, account, key, { agreedWordingVersion: 1, company: null });
    }
    await app.host.settle();
    await fixture.control.advanceTo('delivered');
    await app.host.settle();
    const chat = db.get<{ id: number }>("SELECT id FROM chat WHERE chat_key='selected'")?.id;
    const unrelated = db.get<{ id: number }>("SELECT id FROM chat WHERE chat_key='unrelated'")?.id;
    const message = db.get<{ id: number }>("SELECT id FROM message WHERE message_key='message-selected'")?.id;
    const account = accounts.get('alice');
    assert.ok(chat && unrelated && message && account);
    assert.equal(getMessages(ctx, { ids: [message] }).length, 1);
    assert.equal(getBoard(ctx).lanes.length, 2);
    const session = signIn(db, 'alice', 'synthetic-password', now());
    assert.equal(
      (
        await app.fetch(
          new Request(`${config.origin}/board`, { headers: { Cookie: `kanban_session=${session.token}` } }),
        )
      ).status,
      200,
    );
    const held = mode === 'GENERAL' ? general : movement;
    return {
      db,
      app,
      ctx,
      contexts,
      accounts,
      account,
      chat,
      unrelated,
      message,
      lane,
      inputs,
      requests,
      held,
      logout,
      fixture,
      stops: () => stops,
      release(outcome: 'success' | 'reject') {
        if (outcome === 'reject') {
          const error = new Error('Synthetic late rejection');
          if (mode === 'GENERAL') general.response.reject(error);
          else movement.response.reject(error);
        } else if (mode === 'GENERAL') general.response.resolve(decision);
        else {
          const request = requests[0];
          assert.ok(request);
          movement.response.resolve(stay(request));
        }
      },
      async close() {
        general.response.resolve(decision);
        if (requests[0]) movement.response.resolve(stay(requests[0]));
        logout.response.resolve();
        await app.stop();
        db.close();
      },
    };
  } catch (error) {
    general.response.resolve(decision);
    if (requests[0]) movement.response.resolve(stay(requests[0]));
    logout.response.resolve();
    await app.stop();
    db.close();
    throw error;
  }
}
function snapshot(s: Awaited<ReturnType<typeof scenario>>) {
  return {
    chats: s.db.all('SELECT * FROM chat ORDER BY id'),
    selections: s.db.all('SELECT * FROM chat_selection ORDER BY account_id,chat_key'),
    owners: s.db.all('SELECT * FROM account_chat ORDER BY account_id,chat_id'),
    agreements: s.db.all('SELECT * FROM chat_agreement ORDER BY id'),
    messages: s.db.all('SELECT * FROM message ORDER BY id'),
    logs: s.db.all('SELECT * FROM action_log ORDER BY id'),
  };
}
function untouched(s: Awaited<ReturnType<typeof scenario>>) {
  assert.equal(s.db.get<{ n: number }>('SELECT count(*) AS n FROM decision')?.n, 0);
  assert.equal(s.db.get<{ n: number }>('SELECT count(*) AS n FROM review_item')?.n, 0);
  assert.equal(
    s.db.get<{ processed_version: number }>('SELECT processed_version FROM message WHERE id=?', s.message)
      ?.processed_version,
    0,
  );
}

// Prepared S assertions run only on the assembled Agent2+Host3 candidate; no A/D scheduler/forget claim.
for (const mode of ['GENERAL', 'MOVEMENT'] as const) {
  for (const outcome of ['success', 'reject'] as const) {
    for (const action of ['withdraw', 'exclude'] as const) {
      test(`S ${mode} actual direct Host ${action}, signal BEFORE return/release, late ${outcome} inert`, async () => {
        const s = await scenario(mode);
        try {
          const work = s.app.pipeline.processNext();
          await s.held.entered.promise;
          assert.ok(s.held.signal);
          assert.equal(s.held.signal.aborted, false);
          if (action === 'withdraw') assert.deepEqual(s.app.host.markWithdrawn(s.ctx, s.account, s.chat), [s.message]);
          else s.app.host.excludeChat(s.ctx, s.account, 'selected');
          assert.equal(s.held.signal.aborted, true); // before any manually released raw provider settlement
          assert.equal(await work, null);
          untouched(s);
          const afterHost = snapshot(s);
          s.release(outcome);
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert.deepEqual(snapshot(s), afterHost);
          assert.equal(s.inputs.length, 1);
          assert.equal(s.requests.length, mode === 'GENERAL' ? 0 : 1);
          assert.equal(s.db.all('SELECT * FROM message WHERE chat_id=?', s.chat).length, 1); // retained, no physical purge
        } finally {
          await s.close();
        }
      });
    }
    for (const action of ['exclude', 'withdraw'] as const) {
      for (const termination of ['commit', 'rollback', 'deferred-FK', 'log-failure', 'reinclude'] as const) {
        test(`S ${mode} real joined Host ${action} outer ${termination}, late ${outcome}, captured abort after actual exit`, async () => {
          const s = await scenario(mode);
          try {
            const work = s.app.pipeline.processNext();
            await s.held.entered.promise;
            assert.ok(s.held.signal);
            const before = snapshot(s);
            const primary = new AppError('invalid', 'Synthetic outer failure');
            const mutation = () =>
              s.db.tx(() => {
                if (action === 'exclude') s.app.host.excludeChat(s.ctx, s.account, 'selected');
                else s.app.host.markWithdrawn(s.ctx, s.account, s.chat);
                assert.equal(s.held.signal?.aborted, false);
                if (termination === 'rollback') throw primary;
                if (termination === 'deferred-FK') {
                  s.db.run('PRAGMA defer_foreign_keys=ON');
                  s.db.run("INSERT INTO stage(lane_id,name,position) VALUES (999,'bad',0)");
                }
                if (termination === 'log-failure')
                  s.db.run("UPDATE action_log SET action='illegal' WHERE id=(SELECT min(id) FROM action_log)");
                if (termination === 'reinclude')
                  s.app.host.includeChat(s.ctx, s.account, 'selected', { agreedWordingVersion: 1, company: null });
              });
            if (termination === 'rollback') assert.throws(mutation, (error) => error === primary);
            else if (termination === 'deferred-FK') assert.throws(mutation, /FOREIGN KEY/);
            else if (termination === 'log-failure') assert.throws(mutation, /append-only/);
            else mutation();
            assert.equal(s.held.signal.aborted, true);
            assert.equal(await work, null);
            if (['rollback', 'deferred-FK', 'log-failure'].includes(termination)) assert.deepEqual(snapshot(s), before);
            const afterHost = snapshot(s);
            s.release(outcome);
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.deepEqual(snapshot(s), afterHost);
            untouched(s);
            if (termination !== 'commit') {
              await s.app.host.settle();
              assert.equal(await s.app.pipeline.processNext(), s.message);
              assert.equal(s.inputs.length, 2);
            }
          } finally {
            await s.close();
          }
        });
      }
    }
    test(`S ${mode} retained withdrawal/reinclude and fresh authentic message do not revive old ${outcome}`, async () => {
      const s = await scenario(mode);
      try {
        const work = s.app.pipeline.processNext();
        await s.held.entered.promise;
        s.app.host.markWithdrawn(s.ctx, s.account, s.chat);
        assert.equal(s.held.signal?.aborted, true);
        assert.equal(await work, null);
        assert.throws(
          () => s.app.host.includeChat(s.ctx, s.account, 'selected', { agreedWordingVersion: null, company: null }),
          /agreement/,
        );
        s.app.host.includeChat(s.ctx, s.account, 'selected', { agreedWordingVersion: 1, company: null });
        await s.app.host.settle();
        assert.equal(await s.app.pipeline.processNext(), s.message);
        const successor = snapshot(s);
        s.release(outcome);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(snapshot(s), successor);
        await s.fixture.control.advanceTo('new-delivered');
        await s.app.host.settle();
        assert.equal(await s.app.pipeline.drain(), 2); // unrelated + new authentic message, no old-response refill
      } finally {
        await s.close();
      }
    });
  }
  test(`S ${mode} caught inner withdrawal error and same-transaction reinclusion retain captured abort`, async () => {
    const s = await scenario(mode);
    try {
      const work = s.app.pipeline.processNext();
      await s.held.entered.promise;
      const primary = new AppError('invalid', 'Synthetic caught joined error');
      s.db.tx(() => {
        assert.throws(
          () =>
            s.db.tx(() => {
              s.app.host.markWithdrawn(s.ctx, s.account, s.chat);
              throw primary;
            }),
          (error) => error === primary,
        );
        assert.equal(s.held.signal?.aborted, false);
        assert.throws(() => s.app.host.excludeChat(s.ctx, s.account, 'selected'), /withdrawn/);
        s.app.host.includeChat(s.ctx, s.account, 'selected', { agreedWordingVersion: 1, company: null });
        assert.equal(s.held.signal?.aborted, false);
      });
      assert.equal(s.held.signal?.aborted, true);
      assert.equal(await work, null);
      s.release('reject');
      await s.app.host.settle();
      assert.equal(await s.app.pipeline.processNext(), s.message);
    } finally {
      await s.close();
    }
  });
  test(`S ${mode} Alice exclude preserves Bob, withdrawal covers both owners, invalid callers cause zero abort`, async () => {
    const s = await scenario(mode, { shared: true });
    try {
      const work = s.app.pipeline.processNext();
      await s.held.entered.promise;
      const bob = s.contexts.get('bob');
      const bobAccount = s.accounts.get('bob');
      assert.ok(bob && bobAccount);
      assert.throws(() => s.app.host.markWithdrawn(bob, s.account, s.chat), /owner|account/i);
      assert.throws(() => s.app.host.excludeChat(s.ctx, s.account, ''), /chat key/);
      console.log(
        'FIRST_EXACT_APP',
        JSON.stringify({ identity: randomUUID(), memory: true, handles: 0, olderWriters: 0 }),
      );
      const wrongDb = openDb(':memory:');
      try {
        assert.throws(() => s.app.host.markWithdrawn({ ...s.ctx, db: wrongDb }, s.account, s.chat));
      } finally {
        wrongDb.close();
      }
      assert.equal(s.held.signal?.aborted, false);
      s.app.host.excludeChat(s.ctx, s.account, 'selected');
      assert.equal(s.held.signal?.aborted, true);
      assert.equal(await work, null);
      assert.equal(
        s.db.get<{ decision: string }>(
          'SELECT decision FROM chat_selection WHERE account_id=? AND chat_key=?',
          bobAccount,
          'selected',
        )?.decision,
        'included',
      );
      assert.ok(s.db.get('SELECT * FROM account_chat WHERE account_id=? AND chat_id=?', bobAccount, s.chat));
      s.app.host.markWithdrawn(bob, bobAccount, s.chat);
      assert.ok(
        s.db
          .all<{ decision: string }>("SELECT decision FROM chat_selection WHERE chat_key='selected'")
          .every((r) => r.decision === 'withdrawn'),
      );
      assert.equal(s.db.all('SELECT * FROM account_chat WHERE chat_id=?', s.chat).length, 0);
      s.release('success');
      untouched(s);
    } finally {
      await s.close();
    }
  });
  for (const remoteOutcome of ['success', 'reject'] as const) {
    test(`S ${mode} real disconnect local abortion BEFORE held remote logout ${remoteOutcome}`, async () => {
      const s = await scenario(mode, { remoteHold: true });
      try {
        const work = s.app.pipeline.processNext();
        await s.held.entered.promise;
        const disconnect = s.app.host.disconnect(s.ctx, s.account);
        const observed = disconnect.then(
          () => null,
          (error: unknown) => error,
        );
        assert.equal(s.held.signal?.aborted, true);
        assert.equal(
          s.db.get<{ state: string }>('SELECT state FROM channel_account WHERE id=?', s.account)?.state,
          'removed',
        );
        await s.logout.entered.promise;
        assert.equal(await work, null);
        if (remoteOutcome === 'success') s.logout.response.resolve();
        else s.logout.response.reject(new Error('Synthetic remote rejection'));
        const result = await observed;
        if (remoteOutcome === 'success') assert.equal(result, null);
        else {
          assert.ok(result instanceof AppError);
          assert.equal(result.message, 'Account removed; remote logout failed');
        }
        s.release('reject');
        untouched(s);
      } finally {
        await s.close();
      }
    });
  }
  test(`S ${mode} actual teammate removal system disconnect reaches held provider`, async () => {
    const s = await scenario(mode, { shared: true });
    try {
      const work = s.app.pipeline.processNext();
      await s.held.entered.promise;
      const bob = s.contexts.get('bob');
      assert.ok(bob && s.ctx.actor.kind === 'teammate');
      await removeTeammate(bob, s.ctx.actor.id, (id) =>
        s.app.host.disconnect({ ...bob, actor: { kind: 'system' } }, id),
      );
      assert.equal(s.held.signal?.aborted, true);
      assert.equal(await work, null);
      s.release('success');
      untouched(s);
    } finally {
      await s.close();
    }
  });
  for (const abortReject of [false, true]) {
    test(`S ${mode} healthy actual App.stop reaches real connector stop with ${abortReject ? 'abort rejection' : 'signal-ignoring response'}`, async () => {
      const s = await scenario(mode, { abortReject });
      try {
        const work = s.app.pipeline.processNext();
        await s.held.entered.promise;
        await s.app.stop(); // must finish while an ignoring raw response is STILL manually held
        assert.equal(s.held.signal?.aborted, true);
        assert.equal(await work, null);
        assert.equal(s.stops(), 1);
        untouched(s);
        s.release('reject');
        await new Promise<void>((resolve) => setImmediate(resolve));
        untouched(s);
      } finally {
        await s.close();
      }
    });
  }
  test(`S ${mode} unrelated chat serial selection/pending remains eligible after affected managed termination`, async () => {
    const s = await scenario(mode);
    try {
      const work = s.app.pipeline.processNext();
      await s.held.entered.promise;
      s.app.host.markWithdrawn(s.ctx, s.account, s.unrelated);
      assert.equal(s.held.signal?.aborted, false);
      assert.equal(
        s.db.get<{ processed_version: number }>('SELECT processed_version FROM message WHERE id=?', s.message)
          ?.processed_version,
        0,
      );
      s.app.host.excludeChat(s.ctx, s.account, 'selected');
      assert.equal(s.held.signal?.aborted, true);
      assert.equal(await work, null);
      s.app.host.includeChat(s.ctx, s.account, 'unrelated', { agreedWordingVersion: 1, company: null });
      await s.app.host.settle();
      const unrelatedMessage = s.db.get<{ id: number }>('SELECT id FROM message WHERE chat_id=?', s.unrelated)?.id;
      assert.equal(await s.app.pipeline.processNext(), unrelatedMessage);
      s.release('reject');
    } finally {
      await s.close();
    }
  });
  test(`S ${mode} supplied cross-chat card provenance withdrawal cancels retained trigger`, async () => {
    const s = await scenario(mode);
    try {
      const support = s.db.get<{ id: number }>('SELECT id FROM message WHERE chat_id=?', s.unrelated)?.id;
      assert.ok(support);
      const card = createCard(
        s.ctx,
        {
          laneId: s.lane.id,
          title: 'Contributed title',
          summary: 'Contributed summary',
          chatId: s.unrelated,
          messageId: support,
          fromHistory: false,
        },
        { setBy: 'agent' },
      );
      attachMessage(s.ctx, s.message, card.id, { setBy: 'human' });
      const work = s.app.pipeline.processNext();
      await s.held.entered.promise;
      assert.ok(s.inputs[0]?.cards.some((c) => c.id === card.id && c.title === 'Contributed title'));
      s.app.host.markWithdrawn(s.ctx, s.account, s.unrelated);
      assert.equal(s.held.signal?.aborted, true);
      assert.equal(await work, null);
      s.release('success');
      untouched(s);
      assert.equal(
        s.db.get<{ withdrawn_at: string | null }>('SELECT withdrawn_at FROM chat WHERE id=?', s.chat)?.withdrawn_at,
        null,
      );
    } finally {
      await s.close();
    }
  });
  test(`S ${mode} equal numeric IDs in independent actual Apps keep boundary/selection/pending isolated`, async () => {
    const aGate = gate<unknown>();
    const bGate = gate<unknown>();
    const gates = [aGate, bGate];
    let invocations = 0;
    const sharedModel: Model = {
      name: 'same-opaque-model',
      endpointHost: null,
      blocked: null,
      decide(input, signal) {
        const lane = input.lanes[0];
        assert.ok(lane);
        const value = {
          disposition: 'create',
          cardId: null,
          proposalId: null,
          laneId: lane.id,
          title: 'Synthetic card',
          summary: 'Synthetic summary.',
          cardCompanyId: null,
          cardCompanyName: null,
          confidence: 1,
          reason: 'Synthetic SOP',
          move: null,
          contacts: [],
          mentions: [],
        };
        if (mode === 'MOVEMENT') return Promise.resolve(value);
        const held = gates[invocations++];
        assert.ok(held);
        held.signal = signal;
        held.entered.resolve();
        return held.response.promise;
      },
    };
    const a = await scenario(mode, { sharedModel, generalGate: aGate });
    const b = await scenario(mode, { sharedModel, generalGate: bGate });
    try {
      assert.notEqual(a.db, b.db);
      assert.equal(a.chat, b.chat);
      assert.equal(a.message, b.message);
      const awork = a.app.pipeline.processNext();
      const bwork = b.app.pipeline.processNext();
      await Promise.all([a.held.entered.promise, b.held.entered.promise]);
      const beforeB = snapshot(b);
      a.app.host.markWithdrawn(a.ctx, a.account, a.chat);
      assert.equal(a.held.signal?.aborted, true);
      assert.equal(b.held.signal?.aborted, false);
      assert.equal(await awork, null);
      assert.deepEqual(snapshot(b), beforeB);
      b.app.host.excludeChat(b.ctx, b.account, 'selected');
      assert.equal(await bwork, null);
      a.release('reject');
      b.release('success');
      untouched(a);
      untouched(b);
    } finally {
      await a.close();
      await b.close();
    }
  });
  test(`S ${mode} genuine provider invocation error stays visible and releases actual registration`, async () => {
    const primary = new AppError('invalid', 'Synthetic invocation failure');
    const s = await scenario(mode, { invokeError: primary });
    try {
      await assert.rejects(s.app.pipeline.processNext(), (error) => error === primary);
      untouched(s);
      assert.equal(s.inputs.length, 1);
      assert.equal(s.requests.length, mode === 'GENERAL' ? 0 : 1);
      await s.app.stop();
      assert.equal(s.stops(), 1);
    } finally {
      await s.close();
    }
  });
}

test('S actual registration boundary failure BEFORE provider invocation leaves no fake processed/review outcome', async () => {
  const s = await scenario('GENERAL');
  try {
    let work: Promise<number | null> | undefined;
    let observed: Promise<unknown> | undefined;
    s.db.tx(() => {
      work = s.app.pipeline.processNext();
      observed = work.then(
        () => assert.fail('Registration failure must reject'),
        (error: unknown) => error,
      );
    });
    assert.ok(observed);
    const error = await observed;
    assert.ok(error instanceof AppError);
    assert.equal(error.message, 'Agent cancellation registration requires an idle transaction boundary');
    assert.equal(s.inputs.length, 0);
    assert.equal(s.requests.length, 0);
    untouched(s);
  } finally {
    await s.close();
  }
});
