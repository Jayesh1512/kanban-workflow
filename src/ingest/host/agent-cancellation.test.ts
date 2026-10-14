import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { testApp } from '../../../test/harness.ts';
import { createLane, getBoard } from '../../board/index.ts';
import type { Ctx, DecideInput, MovementRequest, MovementResult, TestApp } from '../../contracts/index.ts';
import { AppError } from '../../contracts/index.ts';
import { getMessages } from '../index.ts';
import { accountId, delivery, includedId, message, setup } from './test-support.ts';

type Mode = 'GENERAL' | 'MOVEMENT';
function decision(input: DecideInput) {
  const lane = input.lanes[0];
  assert.ok(lane);
  return {
    disposition: 'create',
    cardId: null,
    proposalId: null,
    laneId: lane.id,
    title: 'Private synthetic ticket',
    summary: 'Private synthetic summary',
    cardCompanyId: null,
    cardCompanyName: null,
    confidence: 1,
    reason: 'Synthetic entry',
    move: null,
    contacts: [],
    mentions: [],
  };
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
async function fixture(mode: Mode, shared = false) {
  const consumer = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
  // The ordinary harness allocates an absent mkdtemp file under the command's private TMPDIR.
  console.log(
    'FIRST_EXACT_HOST3',
    JSON.stringify({ identity: randomUUID(), consumer, tree, handles: 0, allOlderWritersFenced: true }),
  );
  const entered = Promise.withResolvers<void>();
  const general = Promise.withResolvers<unknown>();
  const movement = Promise.withResolvers<MovementResult>();
  const signals: AbortSignal[] = [];
  const inputs: DecideInput[] = [];
  const requests: MovementRequest[] = [];
  const names = shared ? ['alice', 'bob'] : ['alice'];
  const h = await testApp({
    lines: [
      ...setup(['selected', 'other', 'cached'], names),
      delivery('alice', 'selected', message(1, { replyToNativeId: 'not-yet-seen' })),
      ...(shared ? [delivery('bob', 'selected', message(1, { replyToNativeId: 'not-yet-seen' }))] : []),
      delivery('alice', 'other', message(2)),
      { t: 'mark', name: 'delivered' },
    ],
    teammates: names.map((username) => ({ username, account: username })),
    model: {
      name: 'opaque-host3',
      endpointHost: null,
      blocked: null,
      decide(input, signal) {
        inputs.push(input);
        if (mode === 'GENERAL') signals.push(signal);
        if (mode === 'GENERAL' && inputs.length === 1) {
          entered.resolve();
          return general.promise;
        }
        return Promise.resolve(decision(input));
      },
    },
    movement: {
      decide(request, signal) {
        requests.push(request);
        if (mode === 'MOVEMENT') signals.push(signal);
        if (mode === 'MOVEMENT' && requests.length === 1) {
          entered.resolve();
          return movement.promise;
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
  });
  try {
    await h.control.advanceTo('setup');
    await h.app.host.startAll();
    for (const name of ['Sales', 'Finance'])
      createLane(h.ctxFor('alice'), {
        name,
        sop: `Synthetic ${name} entry`,
        stages: [
          { name: 'New', criteria: '' },
          { name: 'Done', criteria: 'Completed' },
        ],
      });
    for (const name of names) {
      const ctx = h.ctxFor(name);
      const account = accountId(h, name);
      await h.app.host.listChats(ctx, account);
      for (const key of ['selected', 'other'])
        h.app.host.includeChat(ctx, account, key, { agreedWordingVersion: 1, company: 'Synthetic company' });
    }
    await h.app.host.settle();
    await h.control.advanceTo('delivered');
    await h.app.host.settle();
    const selected = includedId(h);
    const trigger = getMessages(h.ctxFor('alice'), { chatId: selected })[0];
    assert.ok(trigger);
    assert.equal(getBoard(h.ctxFor('alice')).lanes.length, 2);
    return {
      h,
      selected,
      trigger: trigger.id,
      inputs,
      requests,
      signals,
      async hold() {
        const work = h.app.pipeline.processNext();
        await entered.promise;
        const signal = signals[0];
        assert.ok(signal);
        assert.equal(signal.aborted, false);
        return { work, signal };
      },
      release(outcome: 'success' | 'reject') {
        if (outcome === 'reject') {
          const error = new Error('Private late provider rejection');
          if (mode === 'GENERAL') general.reject(error);
          else movement.reject(error);
        } else {
          if (inputs[0]) general.resolve(decision(inputs[0]));
          if (requests[0]) movement.resolve(stay(requests[0]));
        }
      },
      async close() {
        if (inputs[0]) general.resolve(decision(inputs[0]));
        if (requests[0]) movement.resolve(stay(requests[0]));
        await retire(h);
      },
    };
  } catch (error) {
    await retire(h);
    throw error;
  }
}
async function retire(h: TestApp) {
  await h.app.stop();
  h.close();
  await new Promise<void>((resolve) => setImmediate(resolve));
}
function snapshot(h: TestApp) {
  return {
    chats: h.db.all('SELECT * FROM chat ORDER BY id'),
    selections: h.db.all('SELECT * FROM chat_selection ORDER BY account_id,chat_key'),
    accounts: h.db.all('SELECT * FROM channel_account ORDER BY id'),
    holds: h.db.all('SELECT * FROM account_chat ORDER BY account_id,chat_id'),
    sightings: h.db.all('SELECT * FROM message_sighting ORDER BY message_id,account_id'),
    messages: h.db.all('SELECT * FROM message ORDER BY id'),
    decisions: h.db.all('SELECT * FROM decision ORDER BY id'),
    reviews: h.db.all('SELECT * FROM review_item ORDER BY id'),
    log: h.db.all('SELECT * FROM action_log ORDER BY id'),
    status: h.app.pipeline.status(),
  };
}

for (const mode of ['GENERAL', 'MOVEMENT'] as const) {
  for (const outcome of ['success', 'reject'] as const) {
    test(`S Host3 ${mode} Alice exclusion preserves Bob pending; ALL nonidle holds block successor; late ${outcome}`, async () => {
      const s = await fixture(mode, true);
      try {
        const { h } = s;
        const { work, signal } = await s.hold();
        const alice = accountId(h);
        const bob = accountId(h, 'bob');
        const bobPending = h.db.all('SELECT * FROM message_sighting WHERE account_id=?', bob);
        h.app.host.excludeChat(h.ctxFor('alice'), alice, 'selected');
        assert.equal(signal.aborted, true);
        assert.equal(await work, null); // Raw result remains manually held.
        assert.deepEqual(h.db.all('SELECT * FROM message_sighting WHERE account_id=?', bob), bobPending);
        assert.equal(
          h.db.get<{ decision: string }>(
            'SELECT decision FROM chat_selection WHERE account_id=? AND chat_key=?',
            bob,
            'selected',
          )?.decision,
          'included',
        );
        assert.equal(getMessages(h.ctxFor('bob'), { chatId: s.selected }).length, 1);
        // Reincluding Alice creates a real queued Host hold, even though Bob remains usable and idle.
        h.app.host.includeChat(h.ctxFor('alice'), alice, 'selected', { agreedWordingVersion: 1, company: null });
        assert.equal(
          h.db.get<{ sync_state: string }>(
            'SELECT sync_state FROM account_chat WHERE account_id=? AND chat_id=?',
            alice,
            s.selected,
          )?.sync_state,
          'syncing',
        );
        h.app.host.excludeChat(h.ctxFor('alice'), alice, 'other');
        h.app.host.excludeChat(h.ctxFor('bob'), bob, 'other');
        assert.equal(await h.app.pipeline.processNext(), null);
        assert.equal(s.inputs.length, 1);
        await h.app.host.settle();
        assert.equal(await h.app.pipeline.processNext(), s.trigger);
        assert.ok(s.signals[1]);
        assert.notEqual(s.signals[1], signal);
        assert.equal(s.signals[1].aborted, false);
        const successor = snapshot(h);
        s.release(outcome);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(snapshot(h), successor);
        assert.equal(s.inputs.length, 2);
        assert.equal(s.requests.length, mode === 'GENERAL' ? 1 : 2);
      } finally {
        await s.close();
      }
    });
    test(`S Host3 ${mode} last usable owner exclusion blocks fresh calls; real reinclusion selects pending generation; late ${outcome}`, async () => {
      const s = await fixture(mode);
      try {
        const { h } = s;
        const { work, signal } = await s.hold();
        const alice = accountId(h);
        h.app.host.excludeChat(h.ctxFor('alice'), alice, 'selected');
        assert.equal(signal.aborted, true);
        assert.equal(await work, null);
        h.app.host.excludeChat(h.ctxFor('alice'), alice, 'other');
        assert.equal(await h.app.pipeline.processNext(), null);
        assert.equal(await h.app.pipeline.drain(), 0);
        assert.equal(s.inputs.length, 1);
        assert.equal(
          h.db.get<{ processed_version: number }>('SELECT processed_version FROM message WHERE id=?', s.trigger)
            ?.processed_version,
          0,
        );
        h.app.host.includeChat(h.ctxFor('alice'), alice, 'selected', { agreedWordingVersion: 1, company: null });
        assert.equal(await h.app.pipeline.processNext(), null);
        await h.app.host.settle();
        assert.equal(await h.app.pipeline.processNext(), s.trigger);
        assert.ok(s.signals[1]);
        assert.notEqual(s.signals[1], signal);
        assert.equal(s.signals[1].aborted, false);
        const successor = snapshot(h);
        s.release(outcome);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(snapshot(h), successor);
      } finally {
        await s.close();
      }
    });
  }
  test(`S Host3 ${mode} invalid actor/Db/owner/key/included validations cause ZERO cancellation and mutation`, async () => {
    const s = await fixture(mode, true);
    const other = await fixture('GENERAL');
    try {
      const { h } = s;
      const { work, signal } = await s.hold();
      const ctx = h.ctxFor('alice');
      const account = accountId(h);
      const before = snapshot(h);
      const bad: Ctx[] = [
        { ...ctx, actor: { kind: 'agent' } },
        { ...ctx, actor: { kind: 'credential', id: 99999 } },
        h.ctxFor('bob'),
        { ...ctx, db: other.h.db },
        { ...ctx, db: other.h.db, actor: { kind: 'system' } },
      ];
      for (const invalid of bad) {
        assert.throws(() => h.app.host.markWithdrawn(invalid, account, s.selected), AppError);
        assert.throws(() => h.app.host.excludeChat(invalid, account, 'selected'), AppError);
        await assert.rejects(h.app.host.disconnect(invalid, account), AppError);
      }
      assert.throws(() => h.app.host.excludeChat(ctx, account, ''), /chat key/);
      assert.throws(() => h.app.host.excludeChat(ctx, account, 'unlisted'), /not listed/);
      assert.throws(() => h.app.host.markWithdrawn(ctx, account, 99999), /Included owner/);
      assert.equal(signal.aborted, false);
      assert.deepEqual(snapshot(h), before);
      assert.equal(s.inputs.length, 1);
      assert.equal(s.requests.length, mode === 'GENERAL' ? 0 : 1);
      h.app.host.markWithdrawn(ctx, account, s.selected);
      assert.equal(signal.aborted, true);
      assert.equal(await work, null);
      s.release('reject');
    } finally {
      await s.close();
      await other.close();
    }
  });
}

test('S Host3 actual account removal snapshots ALL stored chats, skips cached/empty scopes, preserves unrelated registrations', async () => {
  const s = await fixture('GENERAL');
  const independent = await fixture('GENERAL');
  try {
    const { h } = s;
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const selected = controllers[0];
    const other = controllers[1];
    const absent = controllers[2];
    assert.ok(selected && other && absent);
    const handles = [
      h.db.registerAgentCancellation({ chatIds: [s.selected], messageIds: [] }, selected),
      h.db.registerAgentCancellation({ chatIds: [includedId(h, 'other')], messageIds: [] }, other),
      h.db.registerAgentCancellation({ chatIds: [99999], messageIds: [] }, absent),
    ];
    const separate = new AbortController();
    const separateHandle = independent.h.db.registerAgentCancellation(
      { chatIds: [s.selected], messageIds: [] },
      separate,
    );
    const { work, signal } = await s.hold();
    h.app.host.excludeChat(h.ctxFor('alice'), accountId(h), 'cached');
    assert.equal(signal.aborted, false);
    await h.app.host.disconnect(h.ctxFor('alice'), accountId(h));
    assert.equal(signal.aborted, true);
    assert.equal(await work, null);
    assert.equal(selected.signal.aborted, true);
    assert.equal(other.signal.aborted, true);
    assert.equal(absent.signal.aborted, false);
    assert.equal(separate.signal.aborted, false);
    assert.ok(
      h.db
        .all<{ sync_state: string; sync_origin_state: string }>('SELECT * FROM account_chat')
        .every((row) => row.sync_state === 'idle' && row.sync_origin_state === 'none'),
    );
    assert.ok(
      h.db
        .all<{ reply_to_native_id: string | null }>('SELECT * FROM message_sighting')
        .every((row) => row.reply_to_native_id === null),
    );
    assert.equal(getMessages(h.ctxFor('alice'), {}).length, 2);
    assert.equal(await h.app.pipeline.processNext(), null);
    s.release('reject');
    for (const handle of handles) handle.release();
    separateHandle.release();
  } finally {
    await s.close();
    await independent.close();
  }
});

test('S Host3 cached-only account disconnect has no agent scope and does not invalidate unrelated work', async () => {
  const s = await fixture('GENERAL');
  try {
    const { h } = s;
    const ctx = h.ctxFor('alice');
    const account = accountId(h);
    h.app.host.excludeChat(ctx, account, 'selected');
    h.app.host.excludeChat(ctx, account, 'other');
    const controller = new AbortController();
    const handle = h.db.registerAgentCancellation({ chatIds: [s.selected], messageIds: [] }, controller);
    h.app.host.excludeChat(ctx, account, 'cached');
    await h.app.host.disconnect(ctx, account);
    assert.equal(controller.signal.aborted, false);
    assert.equal(s.inputs.length, 0);
    assert.equal(s.requests.length, 0);
    handle.release();
  } finally {
    await s.close();
  }
});
