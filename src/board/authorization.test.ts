import assert from 'node:assert/strict';
import test from 'node:test';
import { createCredential, removeTeammate, revokeCredential } from '../auth/index.ts';
import type { Ctx } from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';
import { companyVersion, ensureCompany } from '../graph/index.ts';
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
  moveCard,
  unarchiveCard,
  updateCard,
  updateLane,
} from './index.ts';
import { fixture } from './test-fixture.ts';

const laneInput = (name: string) => ({
  name,
  sop: 'Work belongs here',
  stages: [
    { name: 'New', criteria: '' },
    { name: 'Done', criteria: 'Complete' },
  ],
});
const forbidden = (e: unknown) => e instanceof AppError && e.code === 'forbidden';
function snapshot(ctx: Ctx) {
  return {
    lanes: ctx.db.all('SELECT * FROM lane ORDER BY id'),
    stages: ctx.db.all('SELECT * FROM stage ORDER BY id'),
    cards: ctx.db.all('SELECT * FROM card ORDER BY id'),
    chats: ctx.db.all('SELECT * FROM card_chat ORDER BY card_id,chat_id'),
    links: ctx.db.all('SELECT * FROM card_message ORDER BY message_id'),
    offers: ctx.db.all('SELECT * FROM card_offer_dismissed ORDER BY card_id,chat_id'),
    logs: ctx.db.all('SELECT * FROM action_log ORDER BY id'),
    sequence: ctx.db.all('SELECT * FROM sqlite_sequence ORDER BY name'),
    boardVersion: getBoard(ctx).version,
    companyVersion: companyVersion(ctx.db),
  };
}

for (const invalidActor of [
  'missing teammate',
  'missing credential',
  'removed teammate',
  'revoked credential',
  'removed credential owner',
  'system',
]) {
  test(`B1-F1 ordinary board exports reject ${invalidActor} with unchanged state/log/version`, async (t) => {
    const f = await fixture(t);
    const a = createLane(f.ctx, laneInput('A')),
      b = createLane(f.ctx, laneInput('B'));
    const m = f.message(f.chatId);
    const card = createCard(f.agent, { laneId: a.id, title: 'Agent work', messageId: m });
    const archived = createCard(f.ctx, { laneId: a.id, title: 'Archived' });
    archiveCard(f.ctx, archived.id);
    const company = ensureCompany(f.ctx, 'Employer');
    const credential = createCredential(f.ctx, { name: 'Correction credential', scopeMessages: false });
    let rejected: Ctx;
    switch (invalidActor) {
      case 'missing teammate':
        rejected = { ...f.ctx, actor: { kind: 'teammate', id: 999999 } };
        break;
      case 'missing credential':
        rejected = { ...f.ctx, actor: { kind: 'credential', id: 999999 } };
        break;
      case 'system':
        rejected = { ...f.ctx, actor: { kind: 'system' } };
        break;
      case 'removed teammate':
        await removeTeammate(f.h.ctxFor('bob'), f.ctx.actor.kind === 'teammate' ? f.ctx.actor.id : 0, async () => {});
        rejected = f.ctx;
        break;
      case 'revoked credential':
        revokeCredential(f.ctx, credential.id);
        rejected = { ...f.ctx, actor: { kind: 'credential', id: credential.id } };
        break;
      default:
        // Model a persisted stale unrevoked credential with a removed issuer.
        // Token authentication rejects this join even if revocation was missed.
        f.h.db.run(
          'UPDATE teammate SET removed_at=? WHERE id=?',
          f.ctx.now().toISOString(),
          f.ctx.actor.kind === 'teammate' ? f.ctx.actor.id : 0,
        );
        rejected = { ...f.ctx, actor: { kind: 'credential', id: credential.id } };
    }
    const mutations: [string, () => unknown][] = [
      ['moveCard', () => moveCard(rejected, card.id, { stageId: b.stages[0]?.id as number, evidenceMessageIds: [m] })],
      ['createLane', () => createLane(rejected, laneInput('Unauthorized'))],
      ['updateLane', () => updateLane(rejected, a.id, { sop: 'Unauthorized SOP' })],
      ['archiveLane', () => archiveLane(rejected, a.id)],
      ['createCard', () => createCard(rejected, { laneId: a.id, title: 'Unauthorized' })],
      ['updateCard', () => updateCard(rejected, card.id, { title: 'Unauthorized', companyId: company })],
      ['attachMessage', () => attachMessage(rejected, m, null)],
      ['dismissCardOffer', () => dismissCardOffer(rejected, card.id, f.otherChatId)],
      ['archiveCard', () => archiveCard(rejected, card.id)],
      ['unarchiveCard', () => unarchiveCard(rejected, archived.id)],
      // Explicit options must never bypass authorization via nullish defaults.
      ['explicit human', () => moveCard(rejected, card.id, { stageId: b.stages[0]?.id as number }, { setBy: 'human' })],
      ['explicit agent', () => attachMessage(rejected, m, null, { setBy: 'agent' })],
    ];
    for (const [name, mutate] of mutations) {
      const before = snapshot(f.ctx);
      assert.throws(mutate, forbidden, name);
      assert.deepEqual(snapshot(f.ctx), before, name);
    }
    const before = snapshot(f.ctx);
    assert.throws(
      () =>
        f.h.db.tx(() => {
          updateCard(f.h.ctxFor('bob'), card.id, { title: 'Must roll back with denied move' });
          moveCard(rejected, card.id, { stageId: b.stages[0]?.id as number });
        }),
      forbidden,
    );
    assert.deepEqual(snapshot(f.ctx), before);
  });
}

for (const kind of ['teammate', 'credential'] as const) {
  test(`B1-F1 active ${kind} corrections retain named human cross-lane behavior`, async (t) => {
    const f = await fixture(t);
    const credential = createCredential(f.ctx, { name: 'Valid correction', scopeMessages: false });
    const human: Ctx =
      kind === 'teammate' ? f.ctx : { ...f.ctx, actor: { kind, id: credential.id }, canReadText: false };
    const a = createLane(human, laneInput('A')),
      b = createLane(human, laneInput('B'));
    const m = f.message(f.chatId);
    const card = createCard(f.agent, { laneId: a.id, title: 'Agent work', messageId: m });
    moveCard(human, card.id, {
      stageId: b.stages[0]?.id as number,
      criterion: 'Human correction',
      evidenceMessageIds: [m],
    });
    updateCard(human, card.id, { title: 'Corrected' });
    attachMessage(human, m, null);
    attachMessage(human, m, card.id);
    assert.equal(getCard(human, card.id).laneId, b.id);
    assert.equal(getCard(human, card.id).title, 'Corrected');
    assert.equal(getCard(human, card.id).messages[0]?.cardId, card.id);
    assert.equal(
      f.h.db.get<{ set_by: string }>('SELECT set_by FROM card_message WHERE message_id=?', m)?.set_by,
      'human',
    );
    assert.equal(
      f.h.db.get<{ stage_human_set_at: string }>('SELECT stage_human_set_at FROM card WHERE id=?', card.id)
        ?.stage_human_set_at,
      human.now().toISOString(),
    );
    const log = history(human, { action: 'card.move' })[0];
    assert.equal(log?.actor.kind, kind);
    assert.equal(log?.actor.name, kind === 'teammate' ? 'alice' : 'Valid correction');
    assert.deepEqual(log?.messageIds, [m]);
  });
}
