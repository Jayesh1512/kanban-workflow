import assert from 'node:assert/strict';
import test from 'node:test';
import { testApp } from '../../test/harness.ts';
import { attr } from '../../test/html.ts';
import type { FixtureLine } from '../contracts/index.ts';
import { getContact } from '../graph/index.ts';
import { history } from '../log/index.ts';
import { disabledModel, hiddenValue, ingestFixture, laneFields, webTestApp } from './testing.ts';

test('R1 F1 undecided owner can use rendered Exclude directly without including or storing private content', async (t) => {
  const lines: FixtureLine[] = [
    { t: 'account', account: 'alice', self: { userKey: 'self', displayName: 'Alice', handle: null } },
    ...['personal', 'work'].map(
      (key): FixtureLine => ({
        t: 'chat',
        account: 'alice',
        chat: { key, nativeId: key, kind: 'direct', title: `Synthetic ${key}` },
      }),
    ),
    { t: 'mark', name: 'setup' },
    ...['personal', 'work'].map(
      (key): FixtureLine => ({
        t: 'message',
        account: 'alice',
        delivery: 'live',
        chatKey: key,
        message: {
          key: `m-${key}`,
          nativeId: `m-${key}`,
          cursor: '1',
          sender: { userKey: `outside-${key}`, displayName: 'Synthetic outside person', handle: null },
          sentAt: '2026-09-01T09:55:00.000Z',
          text: 'PRIVATE-PAYLOAD-MUST-NOT-BE-STORED',
          media: null,
          replyToNativeId: null,
          editedAt: null,
        },
      }),
    ),
    { t: 'mark', name: 'recent' },
  ];
  const h = await testApp({
    lines,
    model: disabledModel(),
    teammates: [{ username: 'alice', account: 'alice' }, { username: 'jordan' }],
  });
  t.after(async () => {
    await h.app.stop();
    h.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await h.control.advanceTo('setup');
  await h.app.start();
  await h.control.advanceTo('recent');
  await h.app.host.settle();
  const ctx = h.ctxFor('alice');
  const cookie = h.cookieFor('alice');
  const accountId = h.app.host.listAccounts(ctx)[0]?.id;
  assert.ok(accountId);
  const page = await h.get(`/settings/accounts/${accountId}/chats`, { cookie });
  assert.equal(page.status, 200);
  const row = [...(await page.text()).matchAll(/<article class="chat-row">([\s\S]*?)<\/article>/g)].find((m) =>
    m[1]?.includes('Synthetic personal'),
  )?.[1];
  assert.ok(row);
  const exclusion = /<form method="post" action="([^"]+\/exclude)">([\s\S]*?)<\/form>/.exec(row);
  assert.ok(exclusion);
  const action = exclusion[1] as string;
  const chatKey = hiddenValue(exclusion[2] ?? '', 'chatKey');
  assert.equal(chatKey, 'personal');
  assert.equal(attr(await (await h.get('/board', { cookie })).text(), 'my-chats', 'undecided'), '2');
  assert.equal((await h.post(action, { chatKey }, { cookie: h.cookieFor('jordan') })).status, 403);
  assert.equal(h.app.host.chatCounts(ctx).undecidedRecent, 2);
  const response = await h.post(action, { chatKey }, { cookie });
  assert.equal(response.status, 303);
  assert.equal(h.app.host.chatCounts(ctx).undecidedRecent, 1);
  assert.match(await (await h.get(response.headers.get('location') ?? '', { cookie })).text(), /direct · excluded/);
  assert.equal(attr(await (await h.get('/board', { cookie })).text(), 'my-chats', 'undecided'), '1');
  for (const table of ['message', 'chat', 'account_chat', 'chat_agreement'])
    assert.equal(h.db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n, 0, table);
  assert.equal(history(ctx, { action: 'chat.include' }).length, 0);
  assert.equal(history(ctx, { action: 'chat.sync_queue' }).length, 0);
  assert.equal(history(ctx, { action: 'chat.exclude' })[0]?.actor.name, 'alice');
  assert.doesNotMatch(JSON.stringify(history(ctx, {})), /PRIVATE-PAYLOAD-MUST-NOT-BE-STORED/);
  assert.equal(h.control.calls.filter((c) => c.op === 'fetchHistory').length, 0);
});

for (const categories of [
  ['unknown', 'technical'],
  ['technical', 'unknown'],
]) {
  test(`R1 F2 retired finance role stays unchanged with native default or unrelated details; configured order ${categories.join('/')}`, async (t) => {
    const h = await webTestApp(t, true);
    const { contactId, messageIds } = await ingestFixture(h);
    const cookie = h.cookieFor('alice');
    const ctx = h.ctxFor('alice');
    const path = `/contacts/${contactId}`;
    const original = {
      category: 'finance',
      dealsAbout: 'Original evidence-backed role detail',
      evidenceMessageIds: String(messageIds[0]),
      reason: 'Original human classification',
    };
    assert.equal((await h.post(`${path}/role`, original, { cookie })).status, 303);
    assert.equal(
      (
        await h.post(
          '/settings',
          {
            review_threshold: '1',
            role_categories: categories.join('\n'),
            require_agreement: 'on',
            keep_deleted_text: 'on',
          },
          { cookie },
        )
      ).status,
      303,
    );
    const before = getContact(ctx, contactId);
    const logCount = history(ctx, { action: 'contact.set_role' }).length;
    const page = await h.get(path, { cookie });
    assert.equal(page.status, 200);
    const markup = await page.text();
    assert.match(markup, /stored role <strong>finance<\/strong> is no longer configured/);
    const editor = new RegExp(`<form method="post" action="${path}/role">([\\s\\S]*?)</form>`).exec(markup)?.[1];
    assert.ok(editor);
    const selected = /<option value="([^"]*)" selected>([^<]+)<\/option>/.exec(editor);
    assert.ok(selected);
    assert.equal(selected[1], '');
    assert.match(selected[2] ?? '', /finance.*retired/);
    assert.match(editor, /<select name="category" required/);
    const details = { ...original, dealsAbout: 'Unrelated detail edit' };
    assert.equal((await h.post(`${path}/role`, { ...details, category: selected[1] ?? '' }, { cookie })).status, 422);
    const { category: _category, ...withoutChoice } = details;
    assert.equal((await h.post(`${path}/role`, withoutChoice, { cookie })).status, 422);
    assert.equal((await h.post(`${path}/role`, details, { cookie })).status, 422);
    assert.deepEqual(getContact(ctx, contactId), before);
    assert.equal(history(ctx, { action: 'contact.set_role' }).length, logCount);
    assert.equal(
      (
        await h.post(
          `${path}/role`,
          { ...details, category: 'technical', reason: 'Deliberate replacement after settings changed' },
          { cookie },
        )
      ).status,
      303,
    );
    const after = getContact(ctx, contactId);
    assert.equal(after.roleCategory, 'technical');
    assert.equal(after.dealsAbout, details.dealsAbout);
    assert.deepEqual(
      after.roleEvidence.map((m) => m.id),
      before.roleEvidence.map((m) => m.id),
    );
    const entry = history(ctx, { action: 'contact.set_role' })[0];
    assert.equal(entry?.actor.name, 'alice');
    assert.equal(entry?.reason, 'Deliberate replacement after settings changed');
    assert.deepEqual(entry?.messageIds, [messageIds[0]]);
    assert.deepEqual(entry?.before, { category: 'finance', dealsAbout: original.dealsAbout, setBy: 'human' });
  });
}

test('R1 F4 automatic-off board gives a working threshold-specific Settings instruction without suggesting provider repair', async (t) => {
  const h = await webTestApp(t);
  const cookie = h.cookieFor('alice');
  const markup = await (await h.get('/board', { cookie })).text();
  assert.equal(attr(markup, 'status', 'automatic-off'), '1');
  const status = /<header id="status"[\s\S]*?<\/header>/.exec(markup)?.[0];
  assert.ok(status);
  assert.match(status, /Automatic actions are off/);
  assert.match(status, /href="\/settings#review-threshold"/);
  assert.match(status, /Confidence has not been measured/);
  assert.match(status, /Cross-lane moves always need human approval/);
  assert.match(status, /lowering the threshold does not configure providers/);
  assert.match(
    await (await h.get('/settings', { cookie })).text(),
    /id="review-threshold" type="number" name="review_threshold"/,
  );
});

test('R1 F5 server-rendered two-stage forms disable Remove while larger definitions allow it; minimum remains enforced', async (t) => {
  const h = await webTestApp(t);
  const cookie = h.cookieFor('alice');
  const markup = await (await h.get('/lanes', { cookie })).text();
  const buttons = [...markup.matchAll(/<button\b[^>]*data-remove-stage[^>]*>/g)].map((m) => m[0]);
  assert.equal(buttons.length, 2);
  assert.ok(buttons.every((button) => /\bdisabled\b/.test(button)));
  assert.match(markup, /Remove is unavailable at two/);
  const created = await h.post('/lanes', laneFields('Three-stage definition', 3), { cookie });
  assert.equal(created.status, 303);
  const editor = await (await h.get(created.headers.get('location') ?? '', { cookie })).text();
  const available = [...editor.matchAll(/<button\b[^>]*data-remove-stage[^>]*>/g)].map((m) => m[0]);
  assert.equal(available.length, 3);
  assert.ok(available.every((button) => !/\bdisabled\b/.test(button)));
  assert.equal((await h.post('/lanes', laneFields('Invalid single stage', 1), { cookie })).status, 422);
});
