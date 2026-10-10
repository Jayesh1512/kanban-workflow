import assert from 'node:assert/strict';
import test from 'node:test';
import { forgetMessages as forgetGraph } from '../graph/index.ts';
import { deleteMessages } from '../ingest/index.ts';
import { history, redact } from '../log/index.ts';
import { attachMessage, createCard, createLane, forgetMessages, getCard, searchCards, updateCard } from './index.ts';
import { fixture } from './test-fixture.ts';

const laneInput = {
  name: 'Work',
  sop: 'Work',
  stages: [
    { name: 'New', criteria: '' },
    { name: 'Done', criteria: 'Done' },
  ],
};

test('R31 board callback removes affected empty cards, prunes chatlinks, clears only agent text, retains human text and refills', async (t) => {
  const f = await fixture(t),
    lane = createLane(f.ctx, laneInput),
    a = f.message(f.chatId),
    b = f.message(f.chatId),
    d = f.message(f.chatId),
    keep = f.message(f.otherChatId),
    keepHuman = f.message(f.otherChatId);
  const empty = createCard(f.agent, { laneId: lane.id, title: 'Doomed', messageId: a });
  const retained = createCard(f.agent, {
    laneId: lane.id,
    title: 'Doomed marker',
    summary: 'Generated marker',
    messageId: b,
  });
  attachMessage(f.ctx, keep, retained.id);
  const human = createCard(f.ctx, { laneId: lane.id, title: 'Human title', summary: 'Human summary', messageId: d });
  attachMessage(f.ctx, keepHuman, human.id);
  const manual = createCard(f.ctx, { laneId: lane.id, title: 'Empty manual card' });
  const result = f.h.db.tx(() => {
    f.h.db.run('PRAGMA defer_foreign_keys=ON');
    const r = forgetMessages(f.ctx, [a, b, d]);
    forgetGraph(f.ctx, { messageIds: [a, b, d], chatId: f.chatId });
    redact(f.ctx, {
      messageIds: [a, b, d],
      decisionIds: [],
      cardIds: [...r.removedCardIds, ...r.clearedCardIds],
      reviewItemIds: [],
      contactIds: [],
      companyIds: [],
    });
    deleteMessages(f.ctx, [a, b, d]);
    return r;
  });
  assert.deepEqual(result, { removedCardIds: [empty.id], clearedCardIds: [retained.id] });
  assert.equal(searchCards(f.ctx, { includeArchived: true }).total, 3);
  assert.equal(getCard(f.ctx, retained.id).title, '(title removed)');
  assert.equal(getCard(f.ctx, retained.id).summary, '');
  assert.equal(getCard(f.ctx, human.id).title, 'Human title');
  assert.equal(getCard(f.ctx, manual.id).title, 'Empty manual card');
  assert.deepEqual(
    f.h.db.all<{ chat_id: number }>('SELECT chat_id FROM card_chat WHERE card_id=?', retained.id).map((r) => r.chat_id),
    [f.otherChatId],
  );
  assert.equal(
    f.h.db.get<{ needs_text: number }>('SELECT needs_text FROM card WHERE id=?', retained.id)?.needs_text,
    1,
  );
  assert.ok(history(f.ctx, { subjectKind: 'card', subjectId: retained.id }).every((e) => e.redacted));
  updateCard(f.agent, retained.id, { title: 'Remaining work', summary: 'From retained messages' });
  assert.equal(
    f.h.db.get<{ needs_text: number }>('SELECT needs_text FROM card WHERE id=?', retained.id)?.needs_text,
    0,
  );
  assert.deepEqual(f.h.db.all('PRAGMA foreign_key_check'), []);
});

test('board callback joins caller transaction: injected failure restores cards/messages/chatlinks/log/redaction', async (t) => {
  const f = await fixture(t),
    lane = createLane(f.ctx, laneInput),
    m = f.message(f.chatId);
  const card = createCard(f.agent, { laneId: lane.id, title: 'Rollback', messageId: m });
  const before = JSON.stringify(getCard(f.ctx, card.id));
  assert.throws(
    () =>
      f.h.db.tx(() => {
        f.h.db.run('PRAGMA defer_foreign_keys=ON');
        const r = forgetMessages(f.ctx, [m]);
        redact(f.ctx, {
          messageIds: [m],
          decisionIds: [],
          cardIds: r.removedCardIds,
          reviewItemIds: [],
          contactIds: [],
          companyIds: [],
        });
        deleteMessages(f.ctx, [m]);
        throw new Error('Injected coordinator failure');
      }),
    /Injected/,
  );
  assert.equal(JSON.stringify(getCard(f.ctx, card.id)), before);
  assert.equal(f.h.db.get<{ n: number }>('SELECT count(*) AS n FROM card_chat WHERE card_id=?', card.id)?.n, 1);
  assert.deepEqual(forgetMessages(f.ctx, []), { removedCardIds: [], clearedCardIds: [] });
});
