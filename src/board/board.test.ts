import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError, BoardViewSchema, CardDetailSchema } from '../contracts/index.ts';
import { ensureCompany } from '../graph/index.ts';
import { history } from '../log/index.ts';
import {
  archiveCard,
  archiveLane,
  attachMessage,
  createCard,
  createLane,
  dismissCardOffer,
  getBoard,
  getCard,
  listLanes,
  moveCard,
  searchCards,
  unarchiveCard,
  updateCard,
  updateLane,
} from './index.ts';
import { fixture } from './test-fixture.ts';

const input = (name = 'Sales', n = 3) => ({
  name,
  sop: 'Work belongs here',
  stages: Array.from({ length: n }, (_, i) => ({ name: `Stage ${i}`, criteria: i ? 'Evidence of progress' : '' })),
});
const code = (c: AppError['code']) => (e: unknown) => e instanceof AppError && e.code === c;

test('R1.1–4 direct lanes persist ordered 3/4/5 stages, validate, version, retain SOP history and archive', async (t) => {
  const f = await fixture(t);
  const lanes = [3, 4, 5].map((n) => createLane(f.ctx, input(`Lane ${n}`, n)));
  assert.deepEqual(
    lanes.map((l) => l.stages.length),
    [3, 4, 5],
  );
  assert.throws(() => createLane(f.ctx, { ...input(), sop: ' ' }), code('invalid'));
  assert.throws(
    () => createLane(f.ctx, { ...input(), stages: [input().stages[0] as { name: string; criteria: string }] }),
    code('invalid'),
  );
  const lane = lanes[0];
  assert.ok(lane);
  const changed = updateLane(f.ctx, lane.id, {
    sop: 'New SOP',
    stages: lane.stages
      .map((s) => ({ ...s, criteria: 'New criterion' }))
      .map(({ id, name, criteria }) => ({ id, name, criteria })),
  });
  assert.equal(changed.version, 2);
  assert.ok(changed.stages.every((s) => s.criteria === 'New criterion'));
  const log = history(f.ctx, { action: 'lane.update' })[0];
  assert.ok(log);
  assert.equal(log.actor.name, 'alice');
  assert.equal((log.before as { sop: string }).sop, 'Work belongs here');
  const card = createCard(f.ctx, { laneId: lane.id, title: 'Manual' });
  assert.throws(
    () =>
      updateLane(f.ctx, lane.id, {
        stages: changed.stages.slice(1).map(({ id, name, criteria }) => ({ id, name, criteria })),
      }),
    code('conflict'),
  );
  archiveLane(f.ctx, lane.id);
  assert.equal(listLanes(f.ctx).length, 2);
  assert.equal(listLanes(f.ctx, { includeArchived: true })[0]?.version, 3);
  assert.throws(() => createCard(f.ctx, { laneId: lane.id, title: 'Rejected' }), code('invalid'));
  assert.equal(getCard(f.ctx, card.id).title, 'Manual');
  await f.h.restart();
  assert.deepEqual(
    listLanes(f.h.ctxFor('alice'), { includeArchived: true }).map((l) => l.stages.length),
    [3, 4, 5],
  );
});

test('R1/R12 lane edit supports stage rename swaps/removal, rejects foreign/removed ids and rolls back version/log', async (t) => {
  const f = await fixture(t),
    l = createLane(f.ctx, input()),
    other = createLane(f.ctx, input('Other'));
  const a = l.stages[0],
    b = l.stages[1];
  assert.ok(a && b);
  const updated = updateLane(f.ctx, l.id, {
    stages: [
      { id: a.id, name: b.name, criteria: '' },
      { id: b.id, name: a.name, criteria: 'Met' },
    ],
  });
  assert.deepEqual(
    updated.stages.map((s) => s.name),
    [b.name, a.name],
  );
  const n = getBoard(f.ctx).version;
  assert.throws(
    () =>
      updateLane(f.ctx, l.id, {
        stages: [
          { id: other.stages[0]?.id, name: 'Wrong', criteria: '' },
          { name: 'New', criteria: '' },
        ],
      }),
    code('invalid'),
  );
  assert.equal(getBoard(f.ctx).version, n);
  assert.throws(() => createCard(f.ctx, { laneId: l.id, stageId: l.stages[2]?.id, title: 'Removed' }), code('invalid'));
  const card = createCard(f.agent, { laneId: l.id, title: 'Stale destination check' });
  assert.throws(() => moveCard(f.ctx, card.id, { stageId: l.stages[2]?.id as number }), code('invalid'));
  assert.equal(getCard(f.ctx, card.id).stageId, a.id);
  f.h.db.run(
    "CREATE TRIGGER fail_lane BEFORE INSERT ON action_log WHEN NEW.action='lane.update' BEGIN SELECT RAISE(ABORT,'log failure'); END",
  );
  assert.throws(() => updateLane(f.ctx, l.id, { sop: 'Failed' }), /log failure/);
  assert.equal(listLanes(f.ctx)[0]?.sop, l.sop);
  assert.equal(listLanes(f.ctx)[0]?.version, updated.version);
});

test('R2.2/3 board is shared; full chronological card messages use stored ids/sender/chat beyond default50', async (t) => {
  const f = await fixture(t),
    l = createLane(f.ctx, input());
  const companyId = ensureCompany(f.ctx, 'Acme');
  const card = createCard(f.agent, { laneId: l.id, title: 'Work', chatId: f.chatId, companyId, fromHistory: true });
  const ids = Array.from({ length: 55 }, (_, n) => f.message(f.chatId, `Stored ${n}`));
  for (const id of ids) attachMessage(f.agent, id, card.id);
  f.h.clock.advance(1000);
  const newest = f.message(f.otherChatId, 'Other teammate');
  attachMessage(f.ctx, newest, card.id);
  const board = getBoard(f.ctx);
  BoardViewSchema.parse(board);
  assert.deepEqual(getBoard(f.h.ctxFor('bob')), board);
  assert.deepEqual(
    board.lanes[0]?.cards[0]?.teammates.map((t) => t.name),
    ['alice', 'bob'],
  );
  assert.deepEqual(
    board.lanes[0]?.cards[0]?.contacts.map((c) => c.id),
    [f.contactId],
  );
  const detail = getCard(f.ctx, card.id);
  CardDetailSchema.parse(detail);
  assert.deepEqual(
    detail.messages.map((m) => m.id),
    [...ids, newest],
  );
  for (const m of detail.messages) {
    const stored = f.h.db.get<{ text: string; chat_id: number; sender_identity_id: number }>(
      'SELECT * FROM message WHERE id=?',
      m.id,
    );
    assert.ok(stored);
    assert.equal(m.text, stored.text);
    assert.equal(m.chatId, stored.chat_id);
    assert.equal(m.sender.identityId, stored.sender_identity_id);
  }
  const redacted = getCard({ ...f.ctx, canReadText: false }, card.id);
  assert.ok(redacted.messages.every((m) => m.text === null));
  assert.deepEqual(
    searchCards(f.ctx, { text: 'WORK', companyId, contactId: f.contactId }).cards.map((c) => c.id),
    [card.id],
  );
  assert.equal(searchCards(f.ctx, { text: 'missing' }).total, 0);
  assert.deepEqual(searchCards(f.ctx, { limit: 1, offset: 1 }).cards, []);
});

test('R3.1/3 direct card correction, manual detach memory, human text/company locks, archive and named logs', async (t) => {
  const f = await fixture(t),
    l = createLane(f.ctx, input());
  const m = f.message(f.chatId),
    c = createCard(f.agent, { laneId: l.id, title: 'Agent', summary: 'Generated', messageId: m });
  const company = ensureCompany(f.ctx, 'Corrected employer');
  updateCard(f.ctx, c.id, { title: 'Corrected', summary: 'Human', companyId: company });
  assert.throws(() => updateCard(f.agent, c.id, { title: 'Undo' }), code('forbidden'));
  assert.throws(() => updateCard(f.agent, c.id, { companyId: null }), code('forbidden'));
  assert.throws(() => updateCard(f.agent, c.id, { summary: 'Undo' }, { setBy: 'human' }), code('forbidden'));
  attachMessage(f.ctx, m, null);
  assert.throws(() => attachMessage(f.agent, m, c.id), code('forbidden'));
  const manual = createCard(f.ctx, { laneId: l.id, title: 'Manual', messageId: m });
  assert.equal(getCard(f.ctx, manual.id).messages[0]?.cardId, manual.id);
  assert.equal(getCard(f.ctx, c.id).lastMessageAt, null);
  archiveCard(f.ctx, c.id);
  assert.equal(searchCards(f.ctx, {}).total, 1);
  assert.equal(searchCards(f.ctx, { includeArchived: true }).total, 2);
  unarchiveCard(f.ctx, c.id);
  assert.equal(searchCards(f.ctx, {}).total, 2);
  const corrections = getCard(f.ctx, c.id).history.filter((e) => e.actor.kind === 'teammate');
  assert.ok(corrections.some((e) => e.action === 'message.detach'));
  assert.ok(corrections.every((e) => e.actor.name === 'alice'));
});

test('R12.4/5/9/10 direct stage/archive/agent-crosslane consequences and human timestamp/log evidence', async (t) => {
  const f = await fixture(t),
    a = createLane(f.ctx, input()),
    b = createLane(f.ctx, input('Other'));
  const m = f.message(f.chatId),
    card = createCard(f.agent, { laneId: a.id, title: 'Ticket', messageId: m });
  const dest = b.stages[1]?.id;
  assert.ok(dest);
  assert.throws(() => moveCard(f.agent, card.id, { stageId: dest }), code('forbidden'));
  moveCard(f.ctx, card.id, { stageId: dest, criterion: 'Human correction', evidenceMessageIds: [m] });
  assert.equal(getCard(f.ctx, card.id).laneId, b.id);
  assert.equal(
    f.h.db.get<{ stage_human_set_at: string }>('SELECT stage_human_set_at FROM card WHERE id=?', card.id)
      ?.stage_human_set_at,
    f.h.clock.now().toISOString(),
  );
  const log = history(f.ctx, { action: 'card.move' })[0];
  assert.ok(log);
  assert.deepEqual(log.messageIds, [m]);
  assert.equal(log.actor.name, 'alice');
  archiveLane(f.ctx, a.id);
  assert.throws(() => moveCard(f.ctx, card.id, { stageId: a.stages[0]?.id as number }), code('invalid'));
  for (const fn of [
    () => archiveCard(f.agent, card.id),
    () => unarchiveCard(f.agent, card.id),
    () => archiveLane(f.agent, b.id),
    () => updateLane(f.agent, b.id, { sop: 'Override' }),
    () => createLane(f.agent, input('Agent')),
    () => dismissCardOffer(f.agent, card.id, f.chatId),
  ])
    assert.throws(fn, code('forbidden'));
});

test('R3 manual crosschat only, one cardlink per message and direct log-failure rollback', async (t) => {
  const f = await fixture(t),
    l = createLane(f.ctx, input());
  const m = f.message(f.chatId),
    foreign = f.message(f.otherChatId);
  const a = createCard(f.agent, { laneId: l.id, title: 'First', messageId: m }),
    b = createCard(f.ctx, { laneId: l.id, title: 'Second' });
  assert.throws(() => attachMessage(f.agent, foreign, a.id), code('forbidden'));
  attachMessage(f.ctx, foreign, a.id);
  attachMessage(f.ctx, foreign, b.id);
  assert.equal(f.h.db.get<{ n: number }>('SELECT count(*) AS n FROM card_message WHERE message_id=?', foreign)?.n, 1);
  const version = getBoard(f.ctx).version;
  f.h.db.run(
    "CREATE TRIGGER fail_attach BEFORE INSERT ON action_log WHEN NEW.action='message.attach' BEGIN SELECT RAISE(ABORT,'log failure'); END",
  );
  assert.throws(() => createCard(f.ctx, { laneId: l.id, title: 'Rollback', messageId: foreign }), /log failure/);
  assert.equal(searchCards(f.ctx, {}).total, 2);
  assert.equal(getBoard(f.ctx).version, version);
  assert.equal(getCard(f.ctx, b.id).messages[0]?.id, foreign);
});
