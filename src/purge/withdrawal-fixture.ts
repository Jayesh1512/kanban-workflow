import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { testApp } from '../../test/harness.ts';
import { attachMessage, createCard, createLane } from '../board/index.ts';
import type { Ctx, Model, MovementDecisionProvider } from '../contracts/index.ts';
import { addCompanyAlias, ensureCompany } from '../graph/index.ts';
import { accountId, delivery, includedId, message, setup } from '../ingest/host/test-support.ts';
import { record } from '../log/index.ts';

export async function withdrawalFixture(
  t: TestContext,
  model?: Model,
  empty = false,
  movement?: MovementDecisionProvider,
) {
  const h = await testApp({
    lines: [
      ...setup(['selected', 'other'], ['alice', 'bob']),
      ...(empty
        ? []
        : [
            delivery(
              'alice',
              'selected',
              message(1, { sender: { userKey: 'sole', displayName: 'Sole synthetic', handle: null } }),
            ),
            delivery(
              'bob',
              'selected',
              message(1, { sender: { userKey: 'sole', displayName: 'Sole synthetic', handle: null } }),
            ),
            delivery('alice', 'selected', message(2)),
          ]),
      delivery('alice', 'other', message(3)),
      { t: 'mark', name: 'delivered' },
      delivery(
        'alice',
        'selected',
        message(1, {
          text: 'SYNTHETIC late replay',
          sender: { userKey: 'sole', displayName: 'Sole synthetic', handle: null },
        }),
      ),
      delivery(
        'bob',
        'selected',
        message(1, {
          text: 'SYNTHETIC late replay',
          sender: { userKey: 'sole', displayName: 'Sole synthetic', handle: null },
        }),
      ),
      { t: 'mark', name: 'late-withdraw' },
      delivery('alice', 'other', message(4)),
      { t: 'mark', name: 'next' },
    ],
    teammates: ['alice', 'bob'].map((username) => ({ username, account: username })),
    settings: { review_threshold: 0.5 },
    ...(movement ? { movement } : {}),
    model: model ?? {
      name: 'disabled',
      endpointHost: null,
      blocked: 'no_model',
      async decide() {
        throw new Error('Disabled');
      },
    },
  });
  t.after(async () => {
    await h.app.stop();
    h.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await h.control.advanceTo('setup');
  await h.app.host.startAll();
  const ctx = h.ctxFor('alice');
  const agent: Ctx = { ...ctx, actor: { kind: 'agent' } };
  const alice = accountId(h),
    bob = accountId(h, 'bob');
  for (const [name, id] of [
    ['alice', alice],
    ['bob', bob],
  ] as const) {
    await h.app.host.listChats(h.ctxFor(name), id);
    h.app.host.includeChat(h.ctxFor(name), id, 'selected', { company: null, agreedWordingVersion: 1 });
  }
  h.app.host.includeChat(ctx, alice, 'other', { company: null, agreedWordingVersion: 1 });
  await h.app.host.settle();
  await h.control.advanceTo('delivered');
  await h.app.host.settle();
  const chatId = includedId(h),
    otherChat = includedId(h, 'other');
  const selected = h.db
    .all<{ id: number }>('SELECT id FROM message WHERE chat_id=? ORDER BY id', chatId)
    .map((r) => r.id);
  const other = h.db.get<{ id: number }>('SELECT id FROM message WHERE chat_id=?', otherChat)?.id;
  assert.ok(other);
  const lane = createLane(ctx, {
    name: 'Synthetic sales',
    sop: 'Synthetic',
    stages: [
      { name: 'New', criteria: '' },
      { name: 'Done', criteria: 'Confirmed done' },
    ],
  });
  const card = createCard(agent, {
    laneId: lane.id,
    title: 'Synthetic shared',
    summary: 'Synthetic shared',
    messageId: other,
  });
  if (selected[0]) attachMessage(ctx, selected[0], card.id);
  const human = createCard(ctx, {
    laneId: lane.id,
    title: 'RETAIN human title',
    summary: 'RETAIN human summary',
    messageId: other,
  });
  if (selected[1]) attachMessage(ctx, selected[1], human.id);
  // Reattach the retained message to the agent card; give the human card its
  // own other-chat source, so both mixed retention paths are independently real.
  const extra = h.db.run(
    "INSERT INTO message(chat_id,message_key,sender_identity_id,sent_at,text,origin,stored_at,processed_version) SELECT chat_id,'retained-extra',sender_identity_id,sent_at,'RETAIN other text','live',stored_at,1 FROM message WHERE id=?",
    other,
  ).lastInsertRowid;
  attachMessage(ctx, extra, human.id);
  attachMessage(ctx, other, card.id);
  h.db.run("UPDATE card SET text_set_by='agent' WHERE id=?", card.id);
  const keptCompany = ensureCompany(ctx, 'RETAIN human company');
  const unique = (label: string) => `ERASE${label}${randomUUID().replaceAll('-', '')}`;
  const markers = Object.fromEntries(
    [
      'message',
      'version',
      'chat',
      'title',
      'summary',
      'company',
      'alias',
      'raw',
      'audit',
      'review',
      'log',
      'feedback',
      'pending',
      'request',
      'gap',
    ].map((k) => [k, unique(k)]),
  ) as Record<string, string>;
  markers.gap = '2026-08-31T23:59:59.731Z';
  const company = ensureCompany(ctx, markers.company as string);
  addCompanyAlias(ctx, company, markers.alias as string);
  h.db.run('UPDATE chat SET named_company_id=?,title=? WHERE id=?', company, markers.chat as string, chatId);
  h.db.run('UPDATE card SET title=?,summary=? WHERE id=?', markers.title as string, markers.summary as string, card.id);
  // Global legacy feedback may quote this chat without ANY scoped selector.
  h.db.tx(() => {
    record(ctx, { action: 'card.move', subjectKind: 'card', subjectId: human.id, reason: markers.feedback as string });
    if (selected[0]) {
      const first = selected[0];
      h.db.run('UPDATE message SET text=? WHERE id=?', markers.message as string, first);
      h.db.run(
        'INSERT INTO message_version(message_id,version,text,replaced_at) VALUES (?,0,?,?)',
        first,
        markers.version as string,
        ctx.now().toISOString(),
      );
      h.db.run('UPDATE message_sighting SET reply_to_native_id=? WHERE message_id=?', markers.pending as string, first);
      h.db.run('UPDATE message SET reply_to_message_id=? WHERE id=?', first, selected[1] as number);
      const d = h.db.run(
        "INSERT INTO decision(message_id,message_version,outcome,disposition,confidence,reason,lane_versions,model,raw,decided_at) VALUES (?,1,'none','none',1,?,'{}','synthetic',?,?)",
        other,
        markers.raw as string,
        JSON.stringify({ copied: markers.raw }),
        ctx.now().toISOString(),
      ).lastInsertRowid;
      h.db.run(
        "INSERT INTO movement_decision VALUES (?,1,'review',?,?)",
        d,
        JSON.stringify({ evidence: [{ id: first, text: markers.audit }] }),
        JSON.stringify({ reason: markers.audit }),
      );
      const r = h.db.run(
        "INSERT INTO review_item(kind,group_key,chat_id,proposal,why,confidence,reason,status,created_at,updated_at) VALUES ('new_card','mixed',?,?,'low_confidence',0.5,?,'open',?,?)",
        otherChat,
        JSON.stringify({
          kind: 'new_card',
          laneId: lane.id,
          title: markers.review,
          summary: markers.review,
          companyId: null,
          move: null,
        }),
        markers.review as string,
        ctx.now().toISOString(),
        ctx.now().toISOString(),
      ).lastInsertRowid;
      for (const m of [first, other]) h.db.run('INSERT INTO review_message VALUES (?,?,?)', r, m, d);
      record(ctx, {
        action: 'card.update',
        subjectKind: 'card',
        subjectId: card.id,
        after: { text: markers.log },
        messageIds: [first],
      });
      record(agent, {
        action: 'legacy.context',
        subjectKind: 'chat',
        subjectId: otherChat,
        after: { text: markers.raw },
      });
      // A complete in-flight request with exact origin and retained gap copies.
      h.db.run(
        "UPDATE account_chat SET sync_state='failed',sync_after=?,sync_resume=?,sync_newest=?,sync_since=?,sync_limit=200,sync_origin_state='captured',sync_gap_from=?,sync_failed_since=? WHERE chat_id=?",
        markers.request as string,
        markers.request as string,
        markers.request as string,
        ctx.now().toISOString(),
        markers.gap as string,
        ctx.now().toISOString(),
        chatId,
      );
      h.db.run(
        "INSERT INTO chat_gap(account_id,chat_id,from_time,to_time,opened_at,bound_provenance) VALUES (?,?,?,?,?,'exact')",
        alice,
        chatId,
        markers.gap as string,
        ctx.now().toISOString(),
        ctx.now().toISOString(),
      );
    }
    h.db.run('UPDATE message SET processed_version=version');
  });
  return { h, ctx, agent, alice, bob, chatId, otherChat, selected, other, card, human, company, keptCompany, markers };
}

export function snapshot(ctx: Ctx) {
  return ctx.db
    .all<{ name: string }>(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .map(({ name }) => [name, ctx.db.all(`SELECT * FROM "${name}"`)]);
}
