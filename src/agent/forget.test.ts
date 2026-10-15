import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  DecideInput,
  Model,
  ModelDecision,
  MovementDecisionProvider,
  MovementRequest,
  MovementResult,
} from '../contracts/index.ts';
import { withdrawChat } from '../purge/index.ts';
import { snapshot, withdrawalFixture } from '../purge/withdrawal-fixture.ts';
import { forgetMessages } from './forget.ts';

function none(): ModelDecision {
  return {
    disposition: 'none',
    cardId: null,
    proposalId: null,
    laneId: null,
    title: null,
    summary: null,
    cardCompanyId: null,
    cardCompanyName: null,
    confidence: 1,
    reason: 'SYNTHETIC old private result',
    move: null,
    contacts: [],
    mentions: [],
  };
}

test('real Agent forget validates/empty is inert; unknown context copies erased while metadata fences survive', async (t) => {
  const f = await withdrawalFixture(t);
  const before = snapshot(f.ctx);
  assert.throws(() => forgetMessages(f.ctx, [-1]));
  assert.deepEqual(forgetMessages(f.ctx, []), { decisionIds: [], reviewItemIds: [] });
  assert.deepEqual(snapshot(f.ctx), before);
  f.h.db.run(
    "INSERT INTO pending_mention(message_id,name,name_norm,confidence,created_at) VALUES (?, 'synthetic copied legacy name','synthetic copied legacy name',1,?)",
    f.other,
    f.ctx.now().toISOString(),
  );
  const old = f.h.db.get<{ id: number; message_version: number; outcome: string }>(
    'SELECT id,message_version,outcome FROM decision WHERE message_id=?',
    f.other,
  );
  const forgotten = forgetMessages(f.ctx, [f.selected[0] as number, 999999]);
  assert.ok(forgotten.decisionIds.includes(old?.id as number));
  assert.ok(forgotten.reviewItemIds.length);
  assert.deepEqual(f.h.db.get('SELECT id,message_version,outcome FROM decision WHERE message_id=?', f.other), old);
  assert.equal(f.h.db.get<{ raw: string }>('SELECT raw FROM decision WHERE message_id=?', f.other)?.raw, '{}');
  for (const table of ['movement_decision', 'review_item', 'review_message', 'pending_mention'])
    assert.equal(f.h.db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n, 0);
});

test('R31 SAME real pipeline attachment refills cleared agent text without another model call or a lane/stage change', async (t) => {
  let calls = 0;
  let target = 0;
  let input: DecideInput | null = null;
  const model: Model = {
    name: 'synthetic refill',
    endpointHost: null,
    blocked: null,
    async decide(i) {
      calls++;
      input = i;
      return {
        ...none(),
        disposition: 'attach',
        cardId: target,
        title: 'Fresh remaining title',
        summary: 'Fresh remaining summary',
      };
    },
  };
  const f = await withdrawalFixture(t, model);
  target = f.card.id;
  withdrawChat(f.ctx, f.h.app.host, f.alice, f.chatId);
  assert.equal(calls, 0, 'withdrawal never starts inference');
  await f.h.control.advanceTo('next');
  await f.h.app.host.settle();
  const next = f.h.db.get<{ id: number }>("SELECT id FROM message WHERE message_key='key-4'")?.id;
  assert.ok(next);
  assert.equal(await f.h.app.pipeline.processNext(), next);
  assert.equal(calls, 1);
  assert.ok((input as DecideInput | null)?.cards.find((c) => c.id === target)?.needsText);
  const card = f.h.db.get<{ title: string; summary: string; needs_text: number; lane_id: number; stage_id: number }>(
    'SELECT title,summary,needs_text,lane_id,stage_id FROM card WHERE id=?',
    target,
  );
  assert.deepEqual(
    { ...card },
    {
      title: 'Fresh remaining title',
      summary: 'Fresh remaining summary',
      needs_text: 0,
      lane_id: f.card.laneId,
      stage_id: f.card.stageId,
    },
  );
});

for (const mode of ['general', 'movement'] as const)
  for (const outcome of ['success', 'rejection'] as const) {
    for (const rollback of [false, true])
      test(`actual full purge ${rollback ? 'rollback' : 'commit/reinclude'} fences old ${mode} ${outcome}, actual AbortSignal and fresh successor`, {
        timeout: 10000,
      }, async (t) => {
        const entered = Promise.withResolvers<void>();
        const result = Promise.withResolvers<unknown>();
        const movementResult = Promise.withResolvers<MovementResult>();
        let request: MovementRequest | null = null;
        let movementCalls = 0;
        let signal: AbortSignal | null = null;
        let calls = 0;
        const model: Model = {
          name: 'synthetic held',
          endpointHost: null,
          blocked: null,
          async decide(_input, s) {
            calls++;
            signal = s;
            if (calls === 1 && mode === 'general') {
              entered.resolve();
              return result.promise;
            }
            if (mode === 'movement' && calls === 1)
              return {
                ...none(),
                disposition: 'create',
                laneId: _input.lanes[0]?.id ?? null,
                title: 'Fresh card',
                summary: 'Fresh summary',
                reason: 'FRESH synthetic successor',
              };
            return { ...none(), reason: 'FRESH synthetic successor' };
          },
        };
        const movement: MovementDecisionProvider = {
          status: () => ({
            provider: 'jev',
            execution: 'replay',
            state: 'ready',
            reason: null,
            endpointHost: null,
            model: null,
          }),
          async decide(r, s) {
            movementCalls++;
            signal = s;
            request = r;
            if (movementCalls === 1) {
              entered.resolve();
              return movementResult.promise;
            }
            return {
              provider: 'jev',
              execution: 'replay',
              configuredModel: null,
              providerRequestId: null,
              schemaVersion: 1,
              requestId: r.requestId,
              snapshotHash: r.snapshotHash,
              kind: 'not_requested',
              code: 'no_destination',
            };
          },
        };
        const f = await withdrawalFixture(t, model, false, mode === 'movement' ? movement : undefined);
        f.h.db.run(
          "UPDATE account_chat SET sync_state='idle',sync_origin_state='none',sync_gap_from=NULL,sync_after=NULL,sync_since=NULL,sync_limit=NULL,sync_resume=NULL,sync_newest=NULL,sync_failed_since=NULL WHERE chat_id=?",
          f.chatId,
        );
        // Trigger in retained chat consumes the selected chat through the mixed card.
        f.h.db.run('UPDATE message SET version=2 WHERE id=?', f.other);
        const work = f.h.app.pipeline.processNext();
        await entered.promise;
        assert.equal((signal as AbortSignal | null)?.aborted, false);
        if (rollback)
          f.h.db.run(
            "CREATE TRIGGER fail_late BEFORE DELETE ON message BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END",
          );
        if (rollback) {
          assert.throws(() => withdrawChat(f.ctx, f.h.app.host, f.alice, f.chatId));
          f.h.db.run('DROP TRIGGER fail_late');
        } else {
          withdrawChat(f.ctx, f.h.app.host, f.alice, f.chatId);
          await f.h.app.host.listChats(f.ctx, f.alice);
          f.h.app.host.includeChat(f.ctx, f.alice, 'selected', { company: null, agreedWordingVersion: 1 });
          await f.h.app.host.settle();
        }
        assert.equal((signal as AbortSignal | null)?.aborted, true);
        assert.equal(await work, null);
        const beforeLate = snapshot(f.ctx);
        if (mode === 'general') {
          if (outcome === 'success') result.resolve(none());
          else result.reject(new Error('SYNTHETIC old private rejection'));
        } else {
          assert.ok(request);
          const r = request as MovementRequest;
          if (outcome === 'success')
            movementResult.resolve({
              provider: 'jev',
              execution: 'replay',
              configuredModel: null,
              providerRequestId: null,
              schemaVersion: 1,
              requestId: r.requestId,
              snapshotHash: r.snapshotHash,
              kind: 'not_requested',
              code: 'no_destination',
            });
          else movementResult.reject(new Error('SYNTHETIC old private movement rejection'));
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(snapshot(f.ctx), beforeLate, 'late outcome has no writes/logs/review/status changes');
        // Only retained other-chat work is fresh; selected imports remain processed
        // or held by their actual failed-origin request after a rollback.
        f.h.db.run('UPDATE message SET processed_version=version WHERE chat_id=?', f.chatId);
        assert.equal(await f.h.app.pipeline.processNext(), f.other);
        assert.equal(calls, 2);
        assert.equal(
          f.h.db.get<{ reason: string }>(
            'SELECT reason FROM decision WHERE message_id=? AND message_version=2',
            f.other,
          )?.reason,
          'FRESH synthetic successor',
        );
      });
  }
