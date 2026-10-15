import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setSetting } from '../auth/index.ts';
import { updateCard } from '../board/index.ts';
import type { Ctx } from '../contracts/index.ts';
import { setContactCompany, setContactRole, updateContact } from '../graph/index.ts';
import { history } from '../log/index.ts';
import { withdrawChat } from './index.ts';
import { snapshot, withdrawalFixture } from './withdrawal-fixture.ts';

function physical(ctx: Ctx) {
  const file = ctx.db.all<{ name: string; file: string }>('PRAGMA database_list').find((r) => r.name === 'main')?.file;
  assert.ok(file);
  return [file, `${file}-wal`, `${file}-shm`].filter(existsSync).map((p) => ({ path: p, bytes: readFileSync(p) }));
}

test('R31 real full chain removes synthetic markers from DB/WAL/SHM/FTS, keeps mixed human/shared state and fresh agreements', async (t) => {
  const f = await withdrawalFixture(t);
  const { h, ctx, alice, bob, chatId, selected, markers } = f;
  const sharedContact = h.db.get<{ id: number }>("SELECT contact_id AS id FROM identity WHERE user_key='outside'")?.id;
  assert.ok(sharedContact);
  setContactRole(ctx, sharedContact, {
    category: 'technical',
    dealsAbout: 'RETAIN human role',
    evidenceMessageIds: [selected[1] as number],
  });
  setContactCompany(ctx, sharedContact, { company: { id: f.keptCompany }, evidenceMessageIds: [] });
  // Every marker must have reached actual file-backed SQLite BEFORE erasure.
  const before = Buffer.concat(physical(ctx).map((p) => p.bytes));
  for (const marker of Object.values(markers)) assert.ok(before.includes(Buffer.from(marker)), `unplanted ${marker}`);
  assert.equal(
    h.db.get<{ n: number }>(
      'SELECT count(*) AS n FROM message_fts WHERE message_fts MATCH ?',
      markers.message as string,
    )?.n,
    1,
  );
  const controller = new AbortController();
  const registration = h.db.registerAgentCancellation({ chatIds: [], messageIds: [f.other] }, controller);
  withdrawChat(ctx, h.app.host, alice, chatId);
  assert.equal(controller.signal.aborted, true, 'nonempty Agent dependency forget cancelled other-chat context');
  registration.release();
  for (const file of physical(ctx)) {
    for (const marker of Object.values(markers))
      assert.equal(file.bytes.includes(Buffer.from(marker)), false, `${file.path} retained ${marker}`);
    if (file.path.endsWith('-wal')) assert.equal(file.bytes.length, 0);
  }
  console.log(
    'PHYSICAL_WITHDRAWAL',
    JSON.stringify({
      files: physical(ctx).map((p) => ({ path: p.path, bytes: p.bytes.length })),
      plantedBefore: Object.keys(markers),
      absentAfter: Object.keys(markers),
    }),
  );
  assert.equal(
    h.db.get<{ n: number }>(
      'SELECT count(*) AS n FROM message_fts WHERE message_fts MATCH ?',
      markers.message as string,
    )?.n,
    0,
  );
  assert.deepEqual(h.db.all('PRAGMA foreign_key_check'), []);
  assert.equal(h.db.get<{ defer_foreign_keys: number }>('PRAGMA defer_foreign_keys')?.defer_foreign_keys, 0);
  for (const table of [
    'message',
    'message_version',
    'message_sighting',
    'pending_mention',
    'card_message',
    'review_message',
  ]) {
    const field = table === 'message' ? 'id' : 'message_id';
    assert.equal(
      h.db.get<{ n: number }>(
        `SELECT count(*) AS n FROM ${table} WHERE ${field} IN (SELECT value FROM json_each(?))`,
        JSON.stringify(selected),
      )?.n,
      0,
    );
  }
  assert.equal(h.db.get('SELECT id FROM company WHERE id=?', f.company), undefined);
  assert.ok(h.db.get('SELECT id FROM company WHERE id=?', f.keptCompany));
  assert.equal(h.db.get("SELECT id FROM identity WHERE user_key='sole'"), undefined);
  assert.ok(h.db.get("SELECT id FROM identity WHERE user_key='outside'"));
  assert.equal(
    h.db.get<{ deals_about: string }>('SELECT deals_about FROM contact WHERE id=?', sharedContact)?.deals_about,
    'RETAIN human role',
  );
  assert.equal(
    h.db.get<{ set_by: string }>(
      'SELECT set_by FROM contact_company WHERE contact_id=? AND company_id=?',
      sharedContact,
      f.keptCompany,
    )?.set_by,
    'human',
  );
  assert.deepEqual(
    {
      ...h.db.get<Record<string, string | number>>(
        'SELECT title,summary,needs_text,lane_id,stage_id FROM card WHERE id=?',
        f.card.id,
      ),
    },
    {
      title: '(title removed)',
      summary: '',
      needs_text: 1,
      lane_id: f.card.laneId,
      stage_id: f.card.stageId,
    },
  );
  assert.deepEqual(
    {
      ...h.db.get<Record<string, string | number>>('SELECT title,summary,needs_text FROM card WHERE id=?', f.human.id),
    },
    {
      title: 'RETAIN human title',
      summary: 'RETAIN human summary',
      needs_text: 0,
    },
  );
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM card_message WHERE card_id=?', f.card.id)?.n, 1);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM account_chat WHERE chat_id=?', chatId)?.n, 0);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM chat_gap WHERE chat_id=?', chatId)?.n, 0);
  assert.equal(
    h.db.get<{ n: number }>(
      "SELECT count(*) AS n FROM chat_selection WHERE chat_key='selected' AND decision='withdrawn'",
    )?.n,
    2,
  );
  assert.equal(h.db.get<{ n: number }>("SELECT count(*) AS n FROM chat_agreement WHERE kind='withdrawn'")?.n, 2);
  assert.deepEqual(
    history(ctx, { action: 'chat.withdraw' }).map((r) => [r.subjectId, r.before, r.after, r.reason, r.messageIds]),
    [[chatId, null, null, '', []]],
  );
  const committed = snapshot(ctx);
  await h.control.advanceTo('late-withdraw');
  await h.app.host.settle();
  assert.deepEqual(snapshot(ctx), committed, 'both account connector replays are inert after withdrawal');
  assert.throws(() => withdrawChat(ctx, h.app.host, alice, chatId));
  assert.deepEqual(snapshot(ctx), committed);
  setSetting(ctx, 'require_agreement', false);
  for (const [owner, account] of [
    ['alice', alice],
    ['bob', bob],
  ] as const) {
    await h.app.host.listChats(h.ctxFor(owner), account);
    assert.throws(() =>
      h.app.host.includeChat(h.ctxFor(owner), account, 'selected', { company: null, agreedWordingVersion: null }),
    );
  }
  h.app.host.includeChat(ctx, alice, 'selected', { company: null, agreedWordingVersion: 1 });
  await h.app.host.settle();
  updateCard(ctx, f.card.id, { title: 'RETAIN manual refill' });
  assert.equal(h.db.get<{ needs_text: number }>('SELECT needs_text FROM card WHERE id=?', f.card.id)?.needs_text, 0);
});

const failures = [
  ['Host', 'BEFORE UPDATE ON chat WHEN NEW.withdrawn_at IS NOT NULL'],
  ['Agent', 'BEFORE UPDATE ON decision'],
  ['Board', 'BEFORE DELETE ON card_message'],
  ['Graph', 'BEFORE DELETE ON identity'],
  ['Log redact', 'BEFORE UPDATE ON action_log WHEN NEW.redacted=1'],
  ['global feedback', "BEFORE UPDATE ON action_log WHEN OLD.action='card.move'"],
  ['message deletion', 'BEFORE DELETE ON message'],
  ['withdrawal log', "BEFORE INSERT ON action_log WHEN NEW.action='chat.withdraw'"],
  ['deferred FK commit', "AFTER INSERT ON action_log WHEN NEW.action='chat.withdraw'"],
] as const;
for (const [name, boundary] of failures)
  test(`R31 actual ${name} failure rolls back complete callback chain and resets deferred FKs`, async (t) => {
    let freshCalls = 0;
    const f = await withdrawalFixture(t, {
      name: 'synthetic rollback successor',
      endpointHost: null,
      blocked: null,
      async decide() {
        freshCalls++;
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
          reason: 'Fresh rollback successor',
          move: null,
          contacts: [],
          mentions: [],
        };
      },
    });
    const { ctx, h } = f;
    const controller = new AbortController();
    const registration = h.db.registerAgentCancellation({ chatIds: [f.chatId], messageIds: [] }, controller);
    const original = snapshot(ctx);
    const body =
      name === 'deferred FK commit'
        ? "INSERT INTO note(card_id,text,author_kind,created_at) VALUES (999999,'synthetic FK fault','agent','synthetic');"
        : "SELECT RAISE(ABORT,'synthetic boundary fault');";
    h.db.run(`CREATE TRIGGER fail_withdraw ${boundary} BEGIN ${body} END`);
    assert.throws(() => withdrawChat(ctx, h.app.host, f.alice, f.chatId));
    h.db.run('DROP TRIGGER fail_withdraw');
    assert.deepEqual(snapshot(ctx), original, `${name}: all rows/FTS/request/provenance/logs restored`);
    assert.equal(controller.signal.aborted, true);
    registration.release();
    assert.deepEqual(h.db.all('PRAGMA foreign_key_check'), []);
    assert.equal(h.db.get<{ defer_foreign_keys: number }>('PRAGMA defer_foreign_keys')?.defer_foreign_keys, 0);
    // Rollback restores authority, but never resurrects an old captured controller.
    const fresh = new AbortController();
    const freshRegistration = h.db.registerAgentCancellation({ chatIds: [f.chatId], messageIds: f.selected }, fresh);
    assert.equal(fresh.signal.aborted, false);
    freshRegistration.release();
    await h.app.host.stopAll();
    await h.app.host.startAll();
    await h.app.host.settle();
    await h.control.advanceTo('next');
    await h.app.host.settle();
    const next = h.db.get<{ id: number }>("SELECT id FROM message WHERE message_key='key-4'")?.id;
    assert.ok(next);
    assert.equal(
      await h.app.pipeline.processNext(),
      next,
      'actual Host scheduler and new pipeline attempt can progress after rollback',
    );
    assert.equal(freshCalls, 1);
    withdrawChat(ctx, h.app.host, f.alice, f.chatId);
    assert.equal(h.db.get('SELECT id FROM message WHERE chat_id=?', f.chatId), undefined);
  });

test('invalid actor/account/chat is inert, and an empty included chat still erases unscoped human feedback', async (t) => {
  const f = await withdrawalFixture(t, undefined, true);
  const before = snapshot(f.ctx);
  for (const actor of [
    { kind: 'agent' },
    { kind: 'system' },
    { kind: 'credential', id: 1 },
    f.h.ctxFor('bob').actor,
  ] as const)
    assert.throws(() => withdrawChat({ ...f.ctx, actor }, f.h.app.host, f.alice, f.chatId));
  for (const [account, chat] of [
    [-1, f.chatId],
    [f.alice, 999999],
    [f.bob, f.otherChat],
  ])
    assert.throws(() => withdrawChat(f.ctx, f.h.app.host, account as number, chat as number));
  assert.deepEqual(snapshot(f.ctx), before);
  withdrawChat(f.ctx, f.h.app.host, f.alice, f.chatId);
  assert.equal(history(f.ctx, { action: 'card.move' })[0]?.reason, '');
  assert.equal(history(f.ctx, { action: 'chat.withdraw' }).length, 1);
  assert.ok(f.h.db.get('SELECT id FROM message WHERE id=?', f.other));
});

test('full purge retains exact other-chat role/company evidence, then human contact/card/company values and agreement history', async (t) => {
  const f = await withdrawalFixture(t, {
    name: 'Synthetic proven unrelated role',
    endpointHost: null,
    blocked: null,
    async decide(input) {
      assert.equal(input.cards.length, 0);
      assert.equal(input.proposals.length, 0);
      const person = input.participants.find((p) => p.userKey === 'outside');
      assert.ok(person);
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
        reason: 'Synthetic unrelated input',
        move: null,
        contacts: [
          {
            contactId: person.contactId,
            companyId: null,
            companyName: null,
            companyConfidence: 0,
            roleCategory: 'technical',
            dealsAbout: 'RETAIN exact remaining role',
            roleConfidence: 1,
            evidenceMessageIds: [input.message.id],
          },
        ],
        mentions: [],
      };
    },
  });
  const contact = f.h.db.get<{ id: number }>("SELECT contact_id AS id FROM identity WHERE user_key='outside'")?.id;
  assert.ok(contact);
  // Citation overlap alone was the F1 bug. Strengthen this retained-value fixture:
  // generate the role through the real pipeline with NO mixed card/review input.
  // Restore those unrelated objects afterward; every retention assertion stays.
  f.h.db.run('UPDATE card SET archived_at=?', f.ctx.now().toISOString());
  f.h.db.run("UPDATE review_item SET status='dismissed'");
  f.h.db.run('UPDATE message SET version=2 WHERE id=?', f.other);
  assert.equal(await f.h.app.pipeline.processNext(), f.other);
  f.h.db.run('UPDATE card SET archived_at=NULL');
  f.h.db.run("UPDATE review_item SET status='open'");
  const evidence = [f.selected[1] as number, f.other];
  setContactCompany(
    f.agent,
    contact,
    { company: { id: f.keptCompany }, evidenceMessageIds: evidence },
    { setBy: 'agent' },
  );
  updateContact(f.ctx, contact, { displayName: 'RETAIN human contact name' });
  const agreements = f.h.db.all("SELECT * FROM chat_agreement WHERE kind='confirmed'");
  withdrawChat(f.ctx, f.h.app.host, f.alice, f.chatId);
  assert.equal(
    f.h.db.get<{ deals_about: string }>('SELECT deals_about FROM contact WHERE id=?', contact)?.deals_about,
    'RETAIN exact remaining role',
  );
  assert.equal(
    f.h.db.get<{ display_name: string }>('SELECT display_name FROM contact WHERE id=?', contact)?.display_name,
    'RETAIN human contact name',
  );
  assert.ok(
    f.h.db.get('SELECT company_id FROM contact_company WHERE contact_id=? AND company_id=?', contact, f.keptCompany),
  );
  assert.deepEqual(f.h.db.all("SELECT * FROM chat_agreement WHERE kind='confirmed'"), agreements);
  assert.deepEqual(f.h.db.all('PRAGMA foreign_key_check'), []);
});

test('checkpoint contention never reports physical success; logical withdrawal is committed once and truncation can complete after reader retirement', async (t) => {
  const f = await withdrawalFixture(t);
  const file = f.h.db.all<{ name: string; file: string }>('PRAGMA database_list').find((r) => r.name === 'main')?.file;
  assert.ok(file);
  const reader = new DatabaseSync(file);
  try {
    reader.exec('BEGIN');
    reader.prepare('SELECT * FROM message').all();
    assert.throws(() => withdrawChat(f.ctx, f.h.app.host, f.alice, f.chatId), /Withdrawal committed/);
    assert.equal(f.h.db.get('SELECT id FROM message WHERE chat_id=?', f.chatId), undefined);
    assert.equal(history(f.ctx, { action: 'chat.withdraw' }).length, 1);
  } finally {
    reader.exec('ROLLBACK');
    reader.close();
  }
  assert.equal(f.h.db.get<{ busy: number }>('PRAGMA wal_checkpoint(TRUNCATE)')?.busy, 0);
  for (const p of physical(f.ctx))
    for (const marker of Object.values(f.markers)) assert.equal(p.bytes.includes(Buffer.from(marker)), false);
});
