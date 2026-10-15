import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { attachMessage, createCard } from '../board/index.ts';
import type { DecideInput } from '../contracts/index.ts';
import { ensureIdentity, setContactRole } from '../graph/index.ts';
import { record } from '../log/index.ts';
import { snapshot, withdrawalFixture } from './withdrawal-fixture.ts';

for (const fault of ['none', 'Board output', 'Graph output'] as const)
  test(`CW-R1-F1 real mixed context → B-only outputs → HTTP erasure/retention, ${fault}`, async (t) => {
    let sourceCard = 0;
    let seenInput: DecideInput | undefined;
    let phase: 'control' | 'copy' | 'refill' = 'control';
    let calls = 0;
    let refillTarget = 0;
    let controlContact = 0;
    const f = await withdrawalFixture(t, {
      name: 'synthetic reviewer output copier',
      endpointHost: null,
      blocked: null,
      async decide(input) {
        calls++;
        seenInput = input;
        if (phase === 'refill') {
          assert.equal(input.cards.find((c) => c.id === refillTarget)?.needsText, true);
          return {
            disposition: 'attach',
            cardId: refillTarget,
            proposalId: null,
            laneId: null,
            title: 'Fresh B-only title',
            summary: 'Fresh B-only summary',
            cardCompanyId: null,
            cardCompanyName: null,
            confidence: 1,
            reason: 'Synthetic same-call refill',
            move: null,
            contacts: [],
            mentions: [],
          };
        }
        if (phase === 'control') {
          assert.equal(input.cards.length, 0);
          assert.equal(input.proposals.length, 0);
          return {
            disposition: 'create',
            cardId: null,
            proposalId: null,
            laneId: input.lanes[0]?.id ?? null,
            title: 'RETAIN proven unrelated title',
            summary: 'RETAIN proven unrelated summary',
            cardCompanyId: null,
            cardCompanyName: null,
            confidence: 1,
            reason: 'Synthetic known unrelated input',
            move: null,
            mentions: [],
            contacts: [
              {
                contactId: controlContact,
                companyId: null,
                companyName: null,
                companyConfidence: 0,
                roleCategory: 'technical',
                dealsAbout: 'RETAIN proven unrelated role',
                roleConfidence: 1,
                evidenceMessageIds: [input.message.id],
              },
            ],
          };
        }
        const c = input.cards.find((c) => c.id === sourceCard);
        assert.ok(c);
        const person = input.participants.find((p) => p.userKey === 'outside');
        assert.ok(person);
        return {
          disposition: 'create',
          cardId: null,
          proposalId: null,
          laneId: input.lanes[0]?.id ?? null,
          title: c.title,
          summary: c.summary,
          cardCompanyId: null,
          cardCompanyName: null,
          confidence: 1,
          reason: 'SYNTHETIC copy of supplied mixed-card context',
          move: null,
          contacts: [
            {
              contactId: person.contactId,
              companyId: null,
              companyName: null,
              companyConfidence: 0,
              roleCategory: 'technical',
              dealsAbout: c.summary,
              roleConfidence: 1,
              evidenceMessageIds: [input.message.id],
            },
          ],
          mentions: [],
        };
      },
    });
    sourceCard = f.card.id;
    function participant(key: string): number {
      const identity = ensureIdentity(f.ctx, { channel: 'fixture', userKey: key, displayName: key, handle: null });
      assert.ok(identity.contactId);
      f.h.db.run(
        'INSERT INTO chat_participant(chat_id,identity_id,first_seen_at) VALUES (?,?,?)',
        f.otherChat,
        identity.identityId,
        f.ctx.now().toISOString(),
      );
      return identity.contactId;
    }
    controlContact = participant('known-unrelated');
    const humanContact = participant('human-control');
    setContactRole(f.ctx, humanContact, {
      category: 'finance',
      dealsAbout: 'RETAIN human role',
      evidenceMessageIds: [f.other],
    });
    // Establish complete unrelated support with an ACTUAL pipeline generation,
    // while the mixed cards/review are unavailable as inputs. Then restore them.
    f.h.db.run('UPDATE card SET archived_at=?', f.ctx.now().toISOString());
    f.h.db.run("UPDATE review_item SET status='dismissed'");
    const controlMessage = f.h.db.run(
      "INSERT INTO message(chat_id,message_key,sender_identity_id,sent_at,text,origin,stored_at) SELECT chat_id,'control-input',sender_identity_id,sent_at,'RETAIN unrelated source','live',stored_at FROM message WHERE id=?",
      f.other,
    ).lastInsertRowid;
    assert.equal(await f.h.app.pipeline.processNext(), controlMessage);
    const knownCard = f.h.db.get<{ id: number }>(
      'SELECT card_id AS id FROM card_message WHERE message_id=?',
      controlMessage,
    )?.id;
    assert.ok(knownCard);
    f.h.db.run('UPDATE card SET archived_at=NULL');
    f.h.db.run("UPDATE review_item SET status='open'");
    // A genuinely unknown legacy output in B with no selected-chat link must be
    // cleared too. These owner-created legacy controls are NOT the copied outputs.
    const legacyMessage = f.h.db.run(
      "INSERT INTO message(chat_id,message_key,sender_identity_id,sent_at,text,origin,stored_at,processed_version) SELECT chat_id,'legacy-input',sender_identity_id,sent_at,'RETAIN legacy source','live',stored_at,1 FROM message WHERE id=?",
      f.other,
    ).lastInsertRowid;
    const legacyCard = createCard(f.agent, {
      laneId: f.card.laneId,
      title: 'Unknown legacy generated title',
      summary: 'Unknown legacy summary',
      messageId: legacyMessage,
    });
    const legacyContact = participant('unknown-legacy');
    setContactRole(f.agent, legacyContact, {
      category: 'technical',
      dealsAbout: 'Unknown legacy role',
      evidenceMessageIds: [f.other],
    });
    phase = 'copy';
    // Fixture planted a failed request; restore ordinary included/idle authority
    // before the real production pipeline consumes both chats' mixed-card context.
    f.h.db.run(
      "UPDATE account_chat SET sync_state='idle',sync_origin_state='none',sync_gap_from=NULL,sync_after=NULL,sync_since=NULL,sync_limit=NULL,sync_resume=NULL,sync_newest=NULL,sync_failed_since=NULL WHERE chat_id=?",
      f.chatId,
    );
    await f.h.control.advanceTo('next');
    await f.h.app.host.settle();
    const next = f.h.db.get<{ id: number }>("SELECT id FROM message WHERE message_key='key-4'")?.id;
    assert.ok(next);
    assert.equal(await f.h.app.pipeline.processNext(), next);
    assert.ok(seenInput);
    assert.equal(seenInput.chat.id, f.otherChat);
    assert.ok(seenInput.cards.some((c) => c.title === f.markers.title));
    const produced = f.h.db.get<{ id: number; title: string; summary: string; lane_id: number; stage_id: number }>(
      'SELECT c.id,c.title,c.summary,c.text_set_by,c.needs_text,c.lane_id,c.stage_id FROM card c JOIN card_message cm ON cm.card_id=c.id WHERE cm.message_id=?',
      next,
    );
    assert.ok(produced);
    assert.notEqual(produced.id, sourceCard);
    assert.equal(
      f.h.db.get(
        'SELECT 1 FROM card_message cm JOIN message m ON m.id=cm.message_id WHERE cm.card_id=? AND m.chat_id=?',
        produced.id,
        f.chatId,
      ),
      undefined,
    );
    const contact = seenInput.participants.find((p) => p.userKey === 'outside')?.contactId;
    assert.ok(contact);
    const beforeRole = f.h.db.get<{ deals_about: string }>(
      'SELECT role_set_by,deals_about FROM contact WHERE id=?',
      contact,
    );
    assert.equal(beforeRole?.deals_about, f.markers.summary);
    assert.equal(
      f.h.db.get<{ message_id: number }>(
        "SELECT message_id FROM evidence WHERE contact_id=? AND kind='contact_role'",
        contact,
      )?.message_id,
      next,
    );
    // Subject-only HUMAN history also copies the current generated text. It must
    // be redacted via the newly discovered output selectors in this transaction.
    const copiedLog = f.h.db.tx(() =>
      record(f.ctx, {
        action: 'card.update',
        subjectKind: 'card',
        subjectId: produced.id,
        reason: f.markers.summary,
      }),
    );
    const cookie = f.h.cookieFor('alice');
    if (fault !== 'none') {
      const trigger =
        fault === 'Board output'
          ? `CREATE TRIGGER output_fault BEFORE UPDATE OF title ON card WHEN NEW.id=${produced.id} BEGIN SELECT RAISE(ABORT,'output owner fault'); END`
          : `CREATE TRIGGER output_fault BEFORE UPDATE OF deals_about ON contact WHEN NEW.id=${contact} BEGIN SELECT RAISE(ABORT,'output owner fault'); END`;
      f.h.db.run(trigger);
      const before = snapshot(f.ctx);
      const failed = await f.h.post(
        `/settings/accounts/${f.alice}/chats/${f.chatId}/withdraw`,
        { confirm: 'withdraw' },
        { cookie },
      );
      assert.equal(failed.status, 500);
      assert.deepEqual(snapshot(f.ctx), before, 'new generated-output cleanup rolls back ALL tables atomically');
      assert.deepEqual(f.h.db.all('PRAGMA foreign_key_check'), []);
      assert.equal(f.h.db.get<{ defer_foreign_keys: number }>('PRAGMA defer_foreign_keys')?.defer_foreign_keys, 0);
      f.h.db.run('DROP TRIGGER output_fault');
    }
    const database = f.h.db
      .all<{ name: string; file: string }>('PRAGMA database_list')
      .find((r) => r.name === 'main')?.file;
    assert.ok(database);
    const beforeFiles = [database, `${database}-wal`, `${database}-shm`].filter(existsSync);
    for (const marker of [f.markers.title, f.markers.summary]) {
      assert.ok(marker);
      assert.ok(
        beforeFiles.some((path) => readFileSync(path).includes(Buffer.from(marker))),
        'planted bytes exist BEFORE',
      );
    }
    const response = await f.h.post(
      `/settings/accounts/${f.alice}/chats/${f.chatId}/withdraw`,
      { confirm: 'withdraw' },
      { cookie },
    );
    assert.equal(response.status, 303);
    assert.equal(calls, 2, 'withdrawal starts zero inference');
    const after = f.h.db.get<{
      id: number;
      title: string;
      summary: string;
      needs_text: number;
      lane_id: number;
      stage_id: number;
    }>('SELECT id,title,summary,text_set_by,needs_text,lane_id,stage_id FROM card WHERE id=?', produced.id);
    const afterRole = f.h.db.get<{ role_set_by: string; deals_about: string }>(
      'SELECT role_set_by,deals_about FROM contact WHERE id=?',
      contact,
    );
    // These are actual pipeline outputs, without any selected-chat attachment or citation.
    assert.equal(after?.title, '(title removed)');
    assert.equal(after?.summary, '');
    assert.equal(after?.needs_text, 1);
    assert.equal(after?.lane_id, produced.lane_id);
    assert.equal(after?.stage_id, produced.stage_id);
    assert.equal(afterRole?.deals_about, '');
    assert.equal(f.h.db.get('SELECT id FROM message WHERE chat_id=?', f.chatId), undefined);
    assert.equal(f.h.db.get<{ raw: string }>('SELECT raw FROM decision WHERE message_id=?', next)?.raw, '{}');
    assert.ok(f.h.db.get('SELECT id FROM message WHERE id=?', next));
    assert.equal(f.h.db.get<{ busy: number }>('PRAGMA wal_checkpoint(TRUNCATE)')?.busy, 0);
    assert.equal(
      f.h.db.get<{ title: string }>('SELECT title FROM card WHERE id=?', f.human.id)?.title,
      'RETAIN human title',
    );
    assert.equal(
      f.h.db.get<{ summary: string }>('SELECT summary FROM card WHERE id=?', f.human.id)?.summary,
      'RETAIN human summary',
    );
    assert.equal(
      f.h.db.get<{ title: string }>('SELECT title FROM card WHERE id=?', knownCard)?.title,
      'RETAIN proven unrelated title',
    );
    assert.equal(
      f.h.db.get<{ summary: string }>('SELECT summary FROM card WHERE id=?', knownCard)?.summary,
      'RETAIN proven unrelated summary',
    );
    assert.equal(
      f.h.db.get<{ deals_about: string }>('SELECT deals_about FROM contact WHERE id=?', controlContact)?.deals_about,
      'RETAIN proven unrelated role',
    );
    assert.equal(
      f.h.db.get<{ deals_about: string }>('SELECT deals_about FROM contact WHERE id=?', humanContact)?.deals_about,
      'RETAIN human role',
    );
    assert.equal(
      f.h.db.get<{ title: string }>('SELECT title FROM card WHERE id=?', legacyCard.id)?.title,
      '(title removed)',
    );
    assert.equal(
      f.h.db.get<{ deals_about: string }>('SELECT deals_about FROM contact WHERE id=?', legacyContact)?.deals_about,
      '',
    );
    assert.ok(f.h.db.get('SELECT id FROM company WHERE id=?', f.keptCompany));
    assert.equal(
      f.h.db.get<{ redacted: number }>('SELECT redacted FROM action_log WHERE id=?', copiedLog)?.redacted,
      1,
    );
    assert.ok(f.h.db.get('SELECT id FROM message WHERE id=?', controlMessage));
    assert.ok(f.h.db.get('SELECT id FROM message WHERE id=?', legacyMessage));
    const file = database;
    const files = [file, `${file}-wal`, `${file}-shm`]
      .filter(existsSync)
      .map((path) => ({ path, bytes: readFileSync(path) }));
    assert.ok(files.every((fil) => !fil.bytes.includes(Buffer.from(f.markers.title as string))));
    assert.ok(files.every((fil) => !fil.bytes.includes(Buffer.from(f.markers.summary as string))));
    console.log(
      'PHYSICAL_CURRENT_OUTPUT_ERASED',
      JSON.stringify({
        fault,
        httpStatus: response.status,
        knownCard,
        controlContact,
        humanContact,
        legacyCard: legacyCard.id,
        legacyContact,
        sourceCard,
        otherOnlyCard: produced.id,
        outputMessage: next,
        selectedChat: f.chatId,
        retainedChat: f.otherChat,
        copiedTitle: f.markers.title,
        copiedSummary: f.markers.summary,
        after,
        afterRole,
        files: files.map((fil) => ({
          path: fil.path,
          bytes: fil.bytes.length,
          titlePresent: fil.bytes.includes(Buffer.from(f.markers.title as string)),
          summaryPresent: fil.bytes.includes(Buffer.from(f.markers.summary as string)),
        })),
      }),
    );
    // The SAME next real attachment refills this B-only generated card in one
    // call; preserved unrelated provenance still works after global log erasure.
    phase = 'refill';
    refillTarget = produced.id;
    f.h.db.run('UPDATE message SET version=2 WHERE id=?', controlMessage);
    assert.equal(await f.h.app.pipeline.processNext(), controlMessage);
    assert.equal(calls, 3);
    assert.deepEqual(
      {
        ...f.h.db.get<{ title: string; summary: string; needs_text: number; lane_id: number; stage_id: number }>(
          'SELECT title,summary,needs_text,lane_id,stage_id FROM card WHERE id=?',
          produced.id,
        ),
      },
      {
        title: 'Fresh B-only title',
        summary: 'Fresh B-only summary',
        needs_text: 0,
        lane_id: produced.lane_id,
        stage_id: produced.stage_id,
      },
    );
    const freshRaw = f.h.db.get<{ raw: string }>(
      'SELECT raw FROM decision WHERE message_id=? AND message_version=2',
      controlMessage,
    )?.raw;
    assert.ok(freshRaw);
    assert.equal(
      JSON.parse(freshRaw).__withdrawalContext.unknown,
      false,
      'known unrelated support survives log redaction without becoming legacy',
    );
  });

test('CW-R1-F1 complete producing context survives detached support; citations cannot narrow it', async (t) => {
  let source = 0;
  const f = await withdrawalFixture(t, {
    name: 'Synthetic transitive context',
    endpointHost: null,
    blocked: null,
    async decide(input) {
      const c = input.cards.find((c) => c.id === source);
      return {
        disposition: 'create',
        cardId: null,
        proposalId: null,
        laneId: input.lanes[0]?.id ?? null,
        title: c?.title ?? 'RETAIN proven B title',
        summary: c?.summary ?? 'RETAIN proven B summary',
        cardCompanyId: null,
        cardCompanyName: null,
        confidence: 1,
        reason: 'Synthetic transitive input',
        move: null,
        mentions: [],
        contacts: [],
      };
    },
  });
  f.h.db.run('UPDATE card SET archived_at=?', f.ctx.now().toISOString());
  f.h.db.run("UPDATE review_item SET status='dismissed'");
  const seed = f.h.db.run(
    "INSERT INTO message(chat_id,message_key,sender_identity_id,sent_at,text,origin,stored_at) SELECT chat_id,'transitive-seed',sender_identity_id,sent_at,'RETAIN source','live',stored_at FROM message WHERE id=?",
    f.other,
  ).lastInsertRowid;
  assert.equal(await f.h.app.pipeline.processNext(), seed);
  source = f.h.db.get<{ id: number }>('SELECT card_id AS id FROM card_message WHERE message_id=?', seed)?.id ?? 0;
  assert.ok(source);
  // The first output was genuinely B-only. The next call consumes it while it
  // has A+B support, and durably records that COMPLETE input before any deletion.
  const selected = f.selected[0];
  assert.ok(selected);
  attachMessage(f.ctx, selected, source);
  f.h.db.run(
    "UPDATE account_chat SET sync_state='idle',sync_origin_state='none',sync_gap_from=NULL,sync_after=NULL,sync_since=NULL,sync_limit=NULL,sync_resume=NULL,sync_newest=NULL,sync_failed_since=NULL WHERE chat_id=?",
    f.chatId,
  );
  await f.h.control.advanceTo('next');
  await f.h.app.host.settle();
  const next = f.h.db.get<{ id: number }>("SELECT id FROM message WHERE message_key='key-4'")?.id;
  assert.ok(next);
  assert.equal(await f.h.app.pipeline.processNext(), next);
  const copied = f.h.db.get<{ id: number }>('SELECT card_id AS id FROM card_message WHERE message_id=?', next)?.id;
  assert.ok(copied);
  const raw = f.h.db.get<{ raw: string }>('SELECT raw FROM decision WHERE message_id=?', next)?.raw;
  assert.ok(raw);
  const context = JSON.parse(raw).__withdrawalContext;
  assert.equal(context.unknown, false);
  assert.ok(context.messageIds.includes(selected));
  assert.ok(context.chatIds.includes(f.chatId));
  // No current A attachment remains on EITHER generated output, so discovering
  // the dependency now requires producing context, not just current card links.
  attachMessage(f.ctx, selected, null);
  for (const id of [source, copied])
    assert.equal(
      f.h.db.get(
        'SELECT 1 FROM card_message cm JOIN message m ON m.id=cm.message_id WHERE cm.card_id=? AND m.chat_id=?',
        id,
        f.chatId,
      ),
      undefined,
    );
  assert.equal(
    (
      await f.h.post(
        `/settings/accounts/${f.alice}/chats/${f.chatId}/withdraw`,
        { confirm: 'withdraw' },
        { cookie: f.h.cookieFor('alice') },
      )
    ).status,
    303,
  );
  assert.equal(f.h.db.get<{ title: string }>('SELECT title FROM card WHERE id=?', copied)?.title, '(title removed)');
  assert.equal(
    f.h.db.get<{ title: string }>('SELECT title FROM card WHERE id=?', source)?.title,
    'RETAIN proven B title',
  );
  assert.ok(f.h.db.get('SELECT id FROM message WHERE id=?', seed));
  assert.ok(f.h.db.get('SELECT id FROM message WHERE id=?', next));
});
