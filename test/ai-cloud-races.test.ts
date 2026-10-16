import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { cloudFixture, completed, decision, jevAnswer, jsonResponse } from '../src/agent/cloud-testing.ts';
import { listReview } from '../src/agent/index.ts';
import { createLane, getBoard, updateCard } from '../src/board/index.ts';
import { withdrawChat } from '../src/purge/index.ts';

for (const provider of ['general', 'movement'] as const)
  for (const late of ['success', 'reject'] as const)
    test(`cloud actual SDK/HTTP held ${provider}, real withdrawal, late ${late} cannot resurrect state`, async (t) => {
      const h = await cloudFixture(t, { otherLane: provider === 'movement' });
      const held = Promise.withResolvers<Response>();
      const entered = Promise.withResolvers<void>();
      let success: Response | null = null;
      if (provider === 'general')
        h.handlers.general = async (input) => {
          success = jsonResponse(completed(decision(input)));
          entered.resolve();
          return held.promise;
        };
      else
        h.handlers.movement = async (body) => {
          success = jsonResponse(jevAnswer(body));
          entered.resolve();
          return held.promise;
        };
      await h.deliver('one');
      const pending = h.app.pipeline.processNext();
      await entered.promise;
      const account = h.db.get<{ id: number }>('SELECT id FROM channel_account')?.id;
      const chat = h.db.get<{ id: number }>("SELECT id FROM chat WHERE chat_key='work'")?.id;
      assert.ok(account && chat);
      const signal = h.calls.at(-1)?.init.signal;
      assert.ok(signal);
      withdrawChat(h.ctx, h.app.host, account, chat);
      assert.equal(signal.aborted, true);
      assert.equal(await pending, null);
      if (late === 'success') {
        assert.ok(success);
        held.resolve(success);
      } else held.reject(new Error('LATE-PRIVATE-ERROR'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM decision')?.n, 0);
      assert.equal(listReview(h.ctx).length, 0);
      assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM card')?.n, 0);
      assert.doesNotMatch(JSON.stringify(h.logs), /LATE-PRIVATE/);
    });

test('cloud real decision/log failure rolls back all card, extraction, review, audit and processed writes; retry is a fresh attempt', async (t) => {
  const h = await cloudFixture(t, { otherLane: true, threshold: 0 });
  h.handlers.movement = async (body) => {
    const target = Object.keys(body.questions.movement?.criteria ?? {}).find((id) => id !== 'stay' && id !== 'review');
    assert.ok(target);
    return jsonResponse(jevAnswer(body, target));
  };
  await h.deliver('one');
  h.db.run(
    "CREATE TEMP TRIGGER cloud_fail BEFORE INSERT ON movement_decision BEGIN SELECT RAISE(ABORT,'synthetic atomic fault'); END",
  );
  await assert.rejects(h.app.pipeline.processNext(), /synthetic atomic fault/);
  for (const table of ['card', 'card_message', 'review_item', 'movement_decision', 'decision'])
    assert.equal(h.db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n, 0, table);
  assert.equal(h.db.get<{ processed_version: number }>('SELECT processed_version FROM message')?.processed_version, 0);
  h.db.run('DROP TRIGGER cloud_fail');
  assert.ok(await h.app.pipeline.processNext());
  assert.equal(h.calls.length, 4);
  assert.equal(getBoard(h.ctx).lanes[0]?.cards.length, 1);
  assert.equal(getBoard(h.ctx).lanes[1]?.cards.length, 0);
});

for (const race of ['lane', 'human', 'context'] as const)
  test(`cloud provider-held ${race} edit prevents stale writes and review targets`, async (t) => {
    const h = await cloudFixture(t, { threshold: 0 });
    if (race !== 'lane') {
      await h.deliver('one');
      await h.app.pipeline.drain();
    }
    const held = Promise.withResolvers<Response>();
    const entered = Promise.withResolvers<void>();
    let success: Response | null = null;
    h.handlers.general = async (input) => {
      success = jsonResponse(completed(decision(input)));
      entered.resolve();
      return held.promise;
    };
    await h.deliver(race === 'lane' ? 'one' : 'two');
    const pending = h.app.pipeline.processNext();
    await entered.promise;
    if (race === 'lane')
      createLane(h.ctx, {
        name: 'Added while held',
        sop: 'New work',
        stages: [
          { name: 'New', criteria: '' },
          { name: 'Done', criteria: 'Done' },
        ],
      });
    else {
      const card = getBoard(h.ctx).lanes[0]?.cards[0];
      assert.ok(card);
      updateCard(h.ctx, card.id, { title: race === 'human' ? 'Human retained' : 'Changed supplied context' });
    }
    assert.ok(success);
    held.resolve(success);
    assert.equal(await pending, null);
    assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM decision')?.n, race === 'lane' ? 0 : 1);
  });

test('cloud original backoff survives committed exclude/reinclude, rollback and same-instance stop/start; genuine restart resets memory', async (t) => {
  const h = await cloudFixture(t, { attempts: 1 });
  h.handlers.general = async () => jsonResponse({}, 503);
  await h.deliver('one');
  await h.app.pipeline.processNext();
  const account = h.db.get<{ id: number }>('SELECT id FROM channel_account')?.id;
  assert.ok(account);
  h.app.host.excludeChat(h.ctx, account, 'work');
  h.app.host.includeChat(h.ctx, account, 'work', { company: null, agreedWordingVersion: 1 });
  await h.app.host.settle();
  assert.throws(
    () =>
      h.db.tx(() => {
        h.app.host.excludeChat(h.ctx, account, 'work');
        throw new Error('rollback');
      }),
    /rollback/,
  );
  assert.equal(await h.app.pipeline.processNext(), null);
  assert.equal(h.calls.length, 1);
  await h.app.pipeline.stop();
  h.app.pipeline.start();
  await Promise.resolve();
  await h.app.pipeline.stop();
  assert.equal(h.calls.length, 1);
  await h.restart();
  assert.equal(await h.app.pipeline.processNext(), null);
  assert.equal(h.calls.length, 2, 'fresh construction resets memory only after stop and DB close');
});

test('cloud generated intermediate actual owner provenance survives cold reopen and physical withdrawal erases transitive current copies', async (t) => {
  const marker = 'CLOUD-TRANSITIVE-PRIVATE-MARKER';
  const h = await cloudFixture(t, { threshold: 0, text: marker });
  await h.deliver('one');
  await h.app.pipeline.drain();
  const first = getBoard(h.ctx).lanes[0]?.cards[0];
  assert.ok(first);
  h.handlers.general = async (input) =>
    jsonResponse(
      completed(
        decision(input, {
          title: 'Second generated copy',
          summary: input.recent[0]?.text ?? '',
          contacts: [
            {
              contactId: input.participants[0]?.contactId as number,
              companyId: null,
              companyName: null,
              companyConfidence: 0,
              roleCategory: 'technical',
              dealsAbout: input.recent[0]?.text ?? '',
              roleConfidence: 1,
              evidenceMessageIds: [input.message.id],
            },
          ],
        }),
      ),
    );
  await h.deliver('two');
  await h.app.pipeline.drain();
  const raw = h.db.get<{ raw: string }>(
    "SELECT d.raw FROM decision d JOIN message m ON m.id=d.message_id WHERE m.message_key='two'",
  )?.raw;
  const context = JSON.parse(raw ?? '{}').__withdrawalContext;
  assert.equal(context.version, 2);
  assert.ok(context.cards.length);
  assert.ok(context.roles.length);
  assert.ok(context.messageIds.length >= 2);
  await h.restart();
  const account = h.db.get<{ id: number }>('SELECT id FROM channel_account')?.id;
  const chat = h.db.get<{ id: number }>("SELECT id FROM chat WHERE chat_key='work'")?.id;
  assert.ok(account && chat);
  withdrawChat(h.ctx, h.app.host, account, chat);
  assert.equal(listReview(h.ctx).length, 0);
  assert.doesNotMatch(JSON.stringify(h.db.all('SELECT * FROM action_log')), new RegExp(marker));
  h.db.run('PRAGMA wal_checkpoint(TRUNCATE)');
  assert.equal(readFileSync(h.path).includes(Buffer.from(marker)), false);
});
