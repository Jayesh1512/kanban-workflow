import assert from 'node:assert/strict';
import test from 'node:test';
import { createCredential, removeTeammate, revokeCredential } from '../auth/index.ts';
import {
  attachMessage,
  createCard,
  createLane,
  forgetMessages as forgetBoard,
  getBoard,
  getCard,
  updateCard,
} from '../board/index.ts';
import { fixture } from '../board/test-fixture.ts';
import type { Ctx, WriteOpts } from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';
import { deleteMessages } from '../ingest/index.ts';
import { history } from '../log/index.ts';
import {
  addCompanyAlias,
  bindSelfIdentity,
  companyVersion,
  ensureCompany,
  ensureIdentity,
  forgetMessages,
  getContact,
  markNotSame,
  recordReference,
  removeContactCompany,
  removeReference,
  renameCompany,
  setContactCompany,
  setContactRole,
  updateContact,
} from './index.ts';

const forbidden = (e: unknown) => e instanceof AppError && e.code === 'forbidden';
function snapshot(ctx: Ctx) {
  return {
    contacts: ctx.db.all('SELECT * FROM contact ORDER BY id'),
    identities: ctx.db.all('SELECT * FROM identity ORDER BY id'),
    companies: ctx.db.all('SELECT * FROM company ORDER BY id'),
    aliases: ctx.db.all('SELECT * FROM company_alias ORDER BY alias_norm'),
    notSame: ctx.db.all('SELECT * FROM company_not_same ORDER BY name_norm,company_id'),
    links: ctx.db.all('SELECT * FROM contact_company ORDER BY contact_id,company_id'),
    evidence: ctx.db.all('SELECT * FROM evidence ORDER BY id'),
    references: ctx.db.all('SELECT * FROM company_reference ORDER BY id'),
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
]) {
  test(`B1-F1 ordinary graph exports reject ${invalidActor} with unchanged state/log/version`, async (t) => {
    const f = await fixture(t),
      m = f.message(f.chatId);
    const company = ensureCompany(f.ctx, 'Employer'),
      other = ensureCompany(f.ctx, 'Mentioned');
    setContactCompany(f.ctx, f.contactId, { company: { id: company }, evidenceMessageIds: [m] });
    setContactRole(f.ctx, f.contactId, { category: 'technical', dealsAbout: 'Human role', evidenceMessageIds: [m] });
    const ref = recordReference(f.ctx, { fromCompanyId: company, toCompanyId: other, messageId: m, cardId: null });
    assert.ok(ref);
    const credential = createCredential(f.ctx, { name: 'Correction credential', scopeMessages: false });
    let rejected: Ctx;
    switch (invalidActor) {
      case 'missing teammate':
        rejected = { ...f.ctx, actor: { kind: 'teammate', id: 999999 } };
        break;
      case 'missing credential':
        rejected = { ...f.ctx, actor: { kind: 'credential', id: 999999 } };
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
        f.h.db.run(
          'UPDATE teammate SET removed_at=? WHERE id=?',
          f.ctx.now().toISOString(),
          f.ctx.actor.kind === 'teammate' ? f.ctx.actor.id : 0,
        );
        rejected = { ...f.ctx, actor: { kind: 'credential', id: credential.id } };
    }
    const mutations: [string, () => unknown][] = [
      ['renameCompany', () => renameCompany(rejected, company, 'Unauthorized rename')],
      ['updateContact', () => updateContact(rejected, f.contactId, { displayName: 'Unauthorized contact' })],
      ['ensureCompany new', () => ensureCompany(rejected, 'Unauthorized employer')],
      ['ensureCompany existing', () => ensureCompany(rejected, 'Employer')],
      ['removeContactCompany', () => removeContactCompany(rejected, f.contactId, company)],
      ['removeReference', () => removeReference(rejected, ref)],
      ['addCompanyAlias', () => addCompanyAlias(rejected, company, 'Alias')],
      ['markNotSame', () => markNotSame(rejected, 'Different', company)],
      [
        'recordReference',
        () => recordReference(rejected, { fromCompanyId: other, toCompanyId: company, messageId: m, cardId: null }),
      ],
    ];
    // Reproduce the real auth-created revoked credential contact correction first.
    if (invalidActor === 'revoked credential') {
      const contactCorrection = mutations.splice(1, 1)[0];
      assert.ok(contactCorrection);
      mutations.unshift(contactCorrection);
    }
    for (const options of [undefined, { setBy: 'human' }, { setBy: 'agent' }] satisfies (WriteOpts | undefined)[]) {
      mutations.push(
        [
          'setContactCompany',
          () => setContactCompany(rejected, f.contactId, { company: { id: other }, evidenceMessageIds: [m] }, options),
        ],
        [
          'setContactRole',
          () =>
            setContactRole(
              rejected,
              f.contactId,
              { category: 'finance', dealsAbout: 'Unauthorized role', evidenceMessageIds: [m] },
              options,
            ),
        ],
        [
          'recordReference options',
          () =>
            recordReference(
              rejected,
              { fromCompanyId: other, toCompanyId: company, messageId: m, cardId: null },
              options,
            ),
        ],
      );
    }
    for (const [name, mutate] of mutations) {
      const before = snapshot(f.ctx);
      assert.throws(mutate, forbidden, name);
      assert.deepEqual(snapshot(f.ctx), before, name);
    }
    const before = snapshot(f.ctx);
    assert.throws(
      () =>
        f.h.db.tx(() => {
          renameCompany(f.h.ctxFor('bob'), company, 'Must roll back with denied role');
          setContactRole(rejected, f.contactId, { category: 'finance', dealsAbout: 'Denied', evidenceMessageIds: [m] });
        }),
      forbidden,
    );
    assert.deepEqual(snapshot(f.ctx), before);
  });
}

for (const kind of ['teammate', 'credential'] as const) {
  test(`B1-F1 active ${kind} graph corrections preserve human locks and named logs`, async (t) => {
    const f = await fixture(t),
      m = f.message(f.chatId);
    const credential = createCredential(f.ctx, { name: 'Valid correction', scopeMessages: false });
    const human: Ctx =
      kind === 'teammate' ? f.ctx : { ...f.ctx, actor: { kind, id: credential.id }, canReadText: false };
    const company = ensureCompany(human, 'Employer');
    renameCompany(human, company, 'Corrected employer');
    updateContact(human, f.contactId, { displayName: 'Corrected contact' });
    setContactCompany(human, f.contactId, { company: { id: company }, evidenceMessageIds: [m] });
    setContactRole(human, f.contactId, { category: 'finance', dealsAbout: 'Invoices', evidenceMessageIds: [m] });
    assert.equal(getContact(human, f.contactId).name, 'Corrected contact');
    assert.equal(getContact(human, f.contactId).companies[0]?.name, 'Corrected employer');
    assert.equal(getContact(human, f.contactId).roleCategory, 'finance');
    assert.throws(
      () =>
        setContactRole(f.agent, f.contactId, {
          category: 'technical',
          dealsAbout: 'Override',
          evidenceMessageIds: [m],
        }),
      forbidden,
    );
    const log = history(human, { action: 'contact.set_role' })[0];
    assert.equal(log?.actor.kind, kind);
    assert.equal(log?.actor.name, kind === 'teammate' ? 'alice' : 'Valid correction');
    assert.deepEqual(log?.messageIds, [m]);
  });
}

for (const mutation of ['role', 'company', 'reference'] as const) {
  test(`B1-F2 system ${mutation} write is forbidden with default and explicit WriteOpts; caller rolls back`, async (t) => {
    const f = await fixture(t),
      m = f.message(f.chatId);
    const company = ensureCompany(f.ctx, 'Employer'),
      other = ensureCompany(f.ctx, 'Mentioned');
    setContactRole(f.ctx, f.contactId, { category: 'technical', dealsAbout: 'Human lock', evidenceMessageIds: [m] });
    setContactCompany(f.ctx, f.contactId, { company: { id: company }, evidenceMessageIds: [m] });
    removeContactCompany(f.ctx, f.contactId, other);
    const system: Ctx = { ...f.ctx, actor: { kind: 'system' } };
    for (const options of [undefined, { setBy: 'human' }, { setBy: 'agent' }] satisfies (WriteOpts | undefined)[]) {
      const mutate = () => {
        if (mutation === 'role')
          setContactRole(
            system,
            f.contactId,
            { category: 'finance', dealsAbout: 'System replaced lock', evidenceMessageIds: [m] },
            options,
          );
        if (mutation === 'company')
          setContactCompany(system, f.contactId, { company: { id: other }, evidenceMessageIds: [m] }, options);
        if (mutation === 'reference')
          recordReference(system, { fromCompanyId: company, toCompanyId: other, messageId: m, cardId: null }, options);
      };
      const before = snapshot(f.ctx);
      assert.throws(mutate, forbidden);
      assert.deepEqual(snapshot(f.ctx), before);
      assert.throws(
        () =>
          f.h.db.tx(() => {
            updateContact(f.ctx, f.contactId, { displayName: 'Must roll back' });
            mutate();
          }),
        forbidden,
      );
      assert.deepEqual(snapshot(f.ctx), before);
    }
  });
}

test('B1-F2 enumerated system identity ingestion and caller-transaction purge remain supported', async (t) => {
  const f = await fixture(t);
  const system: Ctx = { ...f.ctx, actor: { kind: 'system' } };
  const identity = ensureIdentity(system, {
    channel: 'fixture',
    userKey: 'system-self',
    displayName: 'Self',
    handle: null,
  });
  assert.ok(identity.contactId);
  const teammateId = f.ctx.actor.kind === 'teammate' ? f.ctx.actor.id : 0;
  assert.equal(
    bindSelfIdentity(system, {
      channel: 'fixture',
      userKey: 'system-self',
      displayName: 'Alice',
      handle: null,
      teammateId,
    }),
    identity.identityId,
  );
  assert.equal(f.h.db.get('SELECT id FROM contact WHERE id=?', identity.contactId), undefined);
  assert.equal(getContact(system, f.contactId).name, 'Client');
  const lane = createLane(f.ctx, {
    name: 'Work',
    sop: 'Work',
    stages: [
      { name: 'New', criteria: '' },
      { name: 'Done', criteria: 'Complete' },
    ],
  });
  const m = f.message(f.chatId),
    keep = f.message(f.otherChatId);
  const card = createCard(f.agent, { laneId: lane.id, title: 'Retained', messageId: m });
  updateCard(f.agent, card.id, { summary: 'Agent summary' });
  // Retain the same card/contact through another chat using a named correction.
  attachMessage(f.ctx, keep, card.id);
  const before = snapshot(f.ctx);
  const cardBefore = getCard(f.ctx, card.id);
  const messagesBefore = f.h.db.all('SELECT * FROM message ORDER BY id');
  assert.throws(
    () =>
      f.h.db.tx(() => {
        f.h.db.run('PRAGMA defer_foreign_keys=ON');
        forgetBoard(system, [m]);
        forgetMessages(system, { messageIds: [m], chatId: f.chatId });
        deleteMessages(system, [m]);
        throw new Error('Caller abort');
      }),
    /Caller abort/,
  );
  assert.deepEqual(snapshot(f.ctx), before);
  assert.deepEqual(getCard(f.ctx, card.id), cardBefore);
  assert.deepEqual(f.h.db.all('SELECT * FROM message ORDER BY id'), messagesBefore);
  f.h.db.tx(() => {
    f.h.db.run('PRAGMA defer_foreign_keys=ON');
    assert.deepEqual(forgetBoard(system, [m]), { removedCardIds: [], clearedCardIds: [card.id] });
    assert.deepEqual(forgetMessages(system, { messageIds: [m], chatId: f.chatId }), {
      removedContactIds: [],
      resetContactIds: [],
      removedCompanyIds: [],
    });
    deleteMessages(system, [m]);
  });
  assert.equal(f.h.db.get('SELECT id FROM message WHERE id=?', m), undefined);
  assert.ok(f.h.db.get('SELECT id FROM message WHERE id=?', keep));
  assert.equal(f.h.db.get<{ needs_text: number }>('SELECT needs_text FROM card WHERE id=?', card.id)?.needs_text, 1);
  assert.deepEqual(f.h.db.all('PRAGMA foreign_key_check'), []);
  assert.equal(history(system, { action: 'card.update' })[0]?.actor.kind, 'system');
});
