import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Ctx, MessageHit, MessageView } from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';
import { openDb } from '../store/db.ts';
import { addMessage, fixture, start, time } from './messages/test-fixture.ts';
import { deleteMessages, getMessages, searchMessages } from './messages.ts';

function ids(messages: MessageView[]): number[] {
  return messages.map((message) => message.id);
}
function hitIds(hits: MessageHit[]): number[] {
  return ids(hits.map((hit) => hit.message));
}
function errorCode(code: AppError['code']): (error: unknown) => boolean {
  return (error) => error instanceof AppError && error.code === code;
}
function withFixture(run: (ctx: Ctx) => void): void {
  const ctx = fixture();
  try {
    run(ctx);
  } finally {
    ctx.db.close();
  }
}

test('M1 sole MessageView has exact sender, self direction, sightings and stored metadata', () => {
  withFixture((ctx) => {
    const [message] = getMessages(ctx, { ids: [2] });
    assert.deepEqual(message, {
      id: 2,
      chatId: 1,
      chatTitle: 'Chat 1',
      channel: 'fixture',
      sender: { identityId: 1, name: 'Self 1', contactId: null, teammateId: 1 },
      direction: 'out',
      sentAt: time(1),
      text: 'Edited planted phrase',
      media: 'document',
      replyToId: 1,
      edited: true,
      deleted: true,
      fromHistory: false,
      cardId: 1,
      teammateIds: [2],
    });
    const [first] = getMessages(ctx, { ids: [1] });
    assert.equal(first?.direction, 'in');
    assert.deepEqual(first?.sender, { identityId: 3, name: 'Alice', contactId: 1, teammateId: null });
    assert.deepEqual(first?.teammateIds, [1, 2]);
    assert.equal(first?.fromHistory, true);
    assert.equal(first?.edited, false);
    assert.equal(first?.deleted, false);
    assert.deepEqual(getMessages(ctx, { ids: [5] })[0]?.teammateIds, []);
    assert.equal(getMessages(ctx, { ids: [4] })[0]?.cardId, null);
  });
});

test('M1 filters intersect, contact covers both directions and every participating chat', () => {
  withFixture((ctx) => {
    assert.deepEqual(ids(getMessages(ctx, {})), [6, 5, 4, 3, 2, 1]);
    assert.deepEqual(ids(getMessages(ctx, { chatId: 1 })), [2, 1]);
    assert.deepEqual(ids(getMessages(ctx, { cardId: 1 })), [2, 1]);
    assert.deepEqual(ids(getMessages(ctx, { contactId: 1 })), [4, 3, 2, 1]);
    assert.deepEqual(ids(getMessages(ctx, { contactId: 2 })), [2, 1]);
    assert.deepEqual(ids(getMessages(ctx, { companyId: 1 })), [4, 3, 2, 1]);
    assert.deepEqual(ids(getMessages(ctx, { companyId: 2 })), [4, 3, 2, 1]);
    assert.deepEqual(ids(getMessages(ctx, { companyId: 3 })), []);
    assert.deepEqual(ids(getMessages(ctx, { companyId: 4 })), [2, 1]);
    assert.deepEqual(ids(getMessages(ctx, { companyId: 5 })), [5]);
    assert.deepEqual(ids(getMessages(ctx, { companyId: 6 })), []);
    assert.deepEqual(ids(getMessages(ctx, { ids: [4, 1, 4, 999], contactId: 1, companyId: 2 })), [4, 1]);
    assert.deepEqual(
      ids(getMessages(ctx, { ids: [1, 2, 3], chatId: 1, cardId: 1, contactId: 2, companyId: 4 })),
      [2, 1],
    );
    assert.deepEqual(getMessages(ctx, { chatId: 2, cardId: 1 }), []);
    assert.deepEqual(getMessages(ctx, { ids: [] }), []);
    for (const filter of [{ ids: [999] }, { chatId: 999 }, { cardId: 999 }, { contactId: 999 }, { companyId: 999 }])
      assert.deepEqual(getMessages(ctx, filter), []);
  });
});

test('M1 limits and exclusive before use sent time, with stable equal-time id order', () => {
  withFixture((ctx) => {
    assert.deepEqual(ids(getMessages(ctx, { limit: 3 })), [6, 5, 4]);
    assert.deepEqual(ids(getMessages(ctx, { before: time(2) })), [3, 2, 1]);
    assert.deepEqual(ids(getMessages(ctx, { before: time(1) })), [1]);
    assert.deepEqual(ids(getMessages(ctx, { contactId: 1, before: time(2), limit: 2 })), [3, 2]);
    assert.deepEqual(ids(getMessages(ctx, { ids: [1, 2, 3], limit: 1 })), [3]);
    assert.deepEqual(getMessages(ctx, { before: start }), []);
    ctx.db.tx(() => {
      for (let id = 7; id <= 65; id++) addMessage(ctx.db, id, 4, 5, 5, 'Window fixture');
    });
    assert.equal(getMessages(ctx, {}).length, 50);
    const requested = Array.from({ length: 65 }, (_, index) => index + 1);
    const all = getMessages(ctx, { ids: requested });
    assert.equal(all.length, 65);
    assert.deepEqual(ids(all).slice(0, 3), [65, 64, 63]);
    assert.deepEqual(ids(all).slice(-3), [3, 2, 1]);
  });
});

test('R24.6 [F] every reader shape redacts text; search refuses before any DB read', () => {
  withFixture((ctx) => {
    const hidden = { ...ctx, canReadText: false, actor: { kind: 'credential' as const, id: 1 } };
    for (const query of [{}, { ids: [1, 2] }, { chatId: 1 }, { cardId: 1 }, { contactId: 1 }, { companyId: 1 }]) {
      const visible = getMessages(ctx, query);
      const redacted = getMessages(hidden, query);
      assert.deepEqual(
        redacted,
        visible.map((message) => ({ ...message, text: null })),
      );
      assert.ok(!JSON.stringify(redacted).includes('planted phrase'));
      assert.ok(!JSON.stringify(redacted).includes('Earlier secret phrase'));
    }
    const noReads: Ctx = {
      ...hidden,
      db: {
        ...ctx.db,
        all: () => {
          throw new Error('Forbidden search touched DB');
        },
      },
    };
    assert.throws(() => searchMessages(noReads, { text: 'planted phrase' }), errorCode('forbidden'));
    assert.throws(() => searchMessages(noReads, { text: '' }), errorCode('forbidden'));
  });
});

test('R20.3 [F] planted phrase returns the real message, chat, deduplicated companies and card', () => {
  withFixture((ctx) => {
    const hits = searchMessages(ctx, { text: 'planted phrase' });
    assert.deepEqual(hitIds(hits), [5, 4, 3, 2, 1]);
    assert.deepEqual(hits[4], {
      message: getMessages(ctx, { ids: [1] })[0],
      companies: [
        { id: 1, name: 'Acme' },
        { id: 2, name: 'Beta' },
        { id: 4, name: 'Card only' },
      ],
      card: { id: 1, title: 'Card 1' },
    });
    assert.deepEqual(hits[0]?.companies, [{ id: 5, name: 'Named only' }]);
    assert.equal(hits[0]?.card, null);
    assert.deepEqual(hits[2]?.companies, [
      { id: 1, name: 'Acme' },
      { id: 2, name: 'Beta' },
    ]);
    assert.equal(hits[1]?.card, null);
    ctx.db.run('UPDATE card SET title=? WHERE id=1', 'Current title');
    assert.equal(searchMessages(ctx, { text: 'Edited planted phrase' })[0]?.card?.title, 'Current title');
  });
});

test('M1 FTS filters and literal phrases safely handle quotes, operators, punctuation and Unicode', () => {
  withFixture((ctx) => {
    assert.deepEqual(
      hitIds(searchMessages(ctx, { text: 'planted phrase', companyId: 1, contactId: 1, limit: 2 })),
      [4, 3],
    );
    assert.deepEqual(hitIds(searchMessages(ctx, { text: 'planted phrase', companyId: 4 })), [2, 1]);
    assert.deepEqual(searchMessages(ctx, { text: 'planted phrase', companyId: 3 }), []);
    assert.deepEqual(searchMessages(ctx, { text: 'planted phrase', companyId: 6 }), []);
    assert.deepEqual(searchMessages(ctx, { text: 'planted phrase', contactId: 999 }), []);
    assert.deepEqual(hitIds(searchMessages(ctx, { text: 'cafe planted phrase' })), [4, 1]);
    assert.deepEqual(hitIds(searchMessages(ctx, { text: '"quotes"' })), [4]);
    assert.deepEqual(searchMessages(ctx, { text: 'phrase planted' }), []);
    assert.deepEqual(searchMessages(ctx, { text: '" OR planted*' }), []);
    assert.deepEqual(searchMessages(ctx, { text: "'); DROP TABLE message; --" }), []);
    assert.deepEqual(searchMessages(ctx, { text: '*** () :-' }), []);
    assert.deepEqual(searchMessages(ctx, { text: 'Earlier secret phrase' }), []);
    assert.equal(getMessages(ctx, {}).length, 6);
    ctx.db.run('UPDATE message SET text=? WHERE id=4', 'Replacement index token');
    assert.deepEqual(hitIds(searchMessages(ctx, { text: 'cafe planted phrase' })), [1]);
    assert.deepEqual(hitIds(searchMessages(ctx, { text: 'Replacement index token' })), [4]);
  });
});

test('M1 invalid query values fail safely without changing state', () => {
  withFixture((ctx) => {
    for (const query of [
      { ids: [0] },
      { chatId: -1 },
      { cardId: 1.5 },
      { contactId: Number.NaN },
      { companyId: Number.MAX_SAFE_INTEGER + 1 },
      { limit: 0 },
      { limit: -1 },
      { limit: 1.5 },
      { limit: Number.POSITIVE_INFINITY },
      { before: 'yesterday' },
      { before: '2026-10-10T00:00:00Z' },
    ])
      assert.throws(() => getMessages(ctx, query), errorCode('invalid'));
    for (const query of [
      { text: '' },
      { text: '   ' },
      { text: '\0bad' },
      { text: 'ok', limit: 0 },
      { text: 'ok', companyId: 0 },
      { text: 'ok', contactId: -1 },
    ])
      assert.throws(() => searchMessages(ctx, query), errorCode('invalid'));
    assert.throws(() => deleteMessages(ctx, [1, 0]), errorCode('invalid'));
    assert.equal(getMessages(ctx, {}).length, 6);
  });
});

test('R31 callback [F] file-backed deletion cascades versions/sightings/dependencies/FTS and clears withdrawn companies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-m1-'));
  const path = join(dir, 'synthetic.db');
  const ctx = fixture(path);
  let closed = false;
  try {
    ctx.db.run('UPDATE chat SET withdrawn_at=? WHERE id=1', time(20));
    const before = getMessages(ctx, {});
    ctx.db.run(`CREATE TRIGGER synthetic_cleanup_failure BEFORE UPDATE OF named_company_id ON chat
      WHEN old.id=1 BEGIN SELECT RAISE(ABORT,'synthetic cleanup failure'); END`);
    assert.throws(() => deleteMessages(ctx, [1, 2]), /synthetic cleanup failure/);
    assert.deepEqual(getMessages(ctx, {}), before);
    assert.deepEqual(hitIds(searchMessages(ctx, { text: 'planted phrase' })), [5, 4, 3, 2, 1]);
    ctx.db.run('DROP TRIGGER synthetic_cleanup_failure');
    ctx.db.tx(() => {
      ctx.db.run('UPDATE chat SET withdrawn_at=?,withdrawn_by=1 WHERE id=1', time(20));
      ctx.db.run(
        "INSERT INTO chat_agreement(account_id,channel,chat_key,kind,teammate_id,at,wording) VALUES (1,'fixture','chat1','confirmed',1,?,'Synthetic agreement')",
        start,
      );
      ctx.db.run("INSERT INTO evidence(kind,contact_id,company_id,message_id) VALUES ('contact_company',1,1,1)");
      ctx.db.run(
        "INSERT INTO decision(id,message_id,message_version,outcome,disposition,confidence,reason,lane_versions,model,raw,decided_at) VALUES (1,1,1,'none','none',1,'fixed','{}','scripted','{}',?)",
        start,
      );
      ctx.db.run("INSERT INTO movement_decision VALUES (1,1,'stay','{}','{}')");
      ctx.db.run(
        "INSERT INTO review_item(id,kind,group_key,chat_id,proposal,why,confidence,reason,status,created_at,updated_at) VALUES (1,'new_card','synthetic',1,'{}','low_confidence',1,'fixed','open',?,?)",
        start,
        start,
      );
      ctx.db.run('INSERT INTO review_message VALUES (1,1,1)');
      ctx.db.run(
        "INSERT INTO pending_mention(message_id,name,name_norm,confidence,created_at) VALUES (1,'Synthetic','synthetic',1,?)",
        start,
      );
      ctx.db.run('UPDATE card SET created_from_message_id=1 WHERE id=1');
      ctx.db.run('UPDATE message SET reply_to_message_id=1 WHERE id=4');
      deleteMessages(ctx, [1, 2, 2, 999]);
    });
    assert.deepEqual(ids(getMessages(ctx, {})), [6, 5, 4, 3]);
    assert.deepEqual(searchMessages(ctx, { text: 'Edited planted phrase' }), []);
    for (const table of [
      'message_version',
      'message_sighting',
      'card_message',
      'evidence',
      'company_reference',
      'decision',
      'review_message',
      'pending_mention',
    ]) {
      assert.equal(
        ctx.db.get<{ count: number }>(`SELECT count(*) AS count FROM ${table} WHERE message_id IN (1,2)`)?.count,
        0,
        table,
      );
    }
    assert.equal(ctx.db.get<{ count: number }>('SELECT count(*) AS count FROM movement_decision')?.count, 0);
    assert.equal(getMessages(ctx, { ids: [4] })[0]?.replyToId, null);
    assert.equal(
      ctx.db.get<{ created_from_message_id: number | null }>('SELECT created_from_message_id FROM card WHERE id=1')
        ?.created_from_message_id,
      null,
    );
    assert.equal(
      ctx.db.get<{ named_company_id: number | null }>('SELECT named_company_id FROM chat WHERE id=1')?.named_company_id,
      null,
    );
    assert.equal(
      ctx.db.get<{ named_company_id: number | null }>('SELECT named_company_id FROM chat WHERE id=3')?.named_company_id,
      5,
    );
    assert.equal(ctx.db.get<{ count: number }>('SELECT count(*) AS count FROM chat_agreement')?.count, 1);
    assert.equal(ctx.db.get<{ count: number }>('SELECT count(*) AS count FROM review_item')?.count, 1);
    assert.deepEqual(ctx.db.all('PRAGMA foreign_key_check'), []);
    ctx.db.close();
    closed = true;
    const reopened = openDb(path);
    try {
      assert.deepEqual(searchMessages({ ...ctx, db: reopened }, { text: 'Edited planted phrase' }), []);
      assert.deepEqual(ids(getMessages({ ...ctx, db: reopened }, {})), [6, 5, 4, 3]);
      reopened.run("INSERT INTO message_fts(message_fts,rank) VALUES ('integrity-check',1)");
    } finally {
      reopened.close();
    }
  } finally {
    if (!closed) ctx.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R31 callback [F] caller rollback restores rows, FTS, sightings, reply links and named companies', () => {
  withFixture((ctx) => {
    const before = getMessages(ctx, {});
    assert.throws(
      () =>
        ctx.db.tx(() => {
          ctx.db.run('UPDATE chat SET withdrawn_at=? WHERE id=1', time(20));
          deleteMessages(ctx, [1, 2]);
          assert.deepEqual(getMessages(ctx, { ids: [1, 2] }), []);
          throw new Error('Synthetic later purge step failed');
        }),
      /Synthetic later purge step failed/,
    );
    assert.deepEqual(getMessages(ctx, {}), before);
    assert.deepEqual(hitIds(searchMessages(ctx, { text: 'planted phrase' })), [5, 4, 3, 2, 1]);
    assert.equal(
      ctx.db.get<{ text: string }>('SELECT text FROM message_version WHERE message_id=2')?.text,
      'Earlier secret phrase',
    );
    assert.equal(
      ctx.db.get<{ named_company_id: number }>('SELECT named_company_id FROM chat WHERE id=1')?.named_company_id,
      1,
    );
  });
});

test('R31 callback [F] empty withdrawn chats clear deferred company FK while active named chats retain it', () => {
  withFixture((ctx) => {
    deleteMessages(ctx, [5]);
    ctx.db.tx(() => {
      ctx.db.run('PRAGMA defer_foreign_keys=ON');
      ctx.db.run('UPDATE chat SET withdrawn_at=? WHERE id=3', time(20));
      ctx.db.run('DELETE FROM company WHERE id=5');
      deleteMessages(ctx, []);
    });
    assert.equal(
      ctx.db.get<{ named_company_id: number | null }>('SELECT named_company_id FROM chat WHERE id=3')?.named_company_id,
      null,
    );
    assert.equal(
      ctx.db.get<{ named_company_id: number }>('SELECT named_company_id FROM chat WHERE id=1')?.named_company_id,
      1,
    );
    assert.equal(getMessages(ctx, {}).length, 5);
    deleteMessages(ctx, [999]);
    assert.equal(getMessages(ctx, {}).length, 5);
    assert.deepEqual(ctx.db.all('PRAGMA foreign_key_check'), []);
  });
});
