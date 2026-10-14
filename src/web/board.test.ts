import assert from 'node:assert/strict';
import test from 'node:test';
import { attr, boardCards } from '../../test/html.ts';
import { createCard, createLane, getCard, listLanes } from '../board/index.ts';
import { ensureCompany, recordReference, setContactCompany } from '../graph/index.ts';
import { history } from '../log/index.ts';
import { ingestFixture, laneFields, webTestApp } from './testing.ts';

test('R1.1/3/4 HTTP lanes preserve independent 3/4/5 stage metadata and refuse invalid definitions', async (t) => {
  const h = await webTestApp(t);
  const cookie = h.cookieFor('alice');
  for (const [name, size] of [
    ['Sales', 3],
    ['Delivery', 4],
    ['Finance', 5],
  ] as const) {
    const r = await h.post('/lanes', laneFields(name, size), { cookie });
    assert.equal(r.status, 303);
    const page = await h.get(r.headers.get('location') ?? '', { cookie });
    assert.equal(page.status, 200);
    assert.match(await page.text(), new RegExp(`${name} stage ${size}`));
  }
  assert.deepEqual(
    listLanes(h.ctxFor('alice')).map((l) => l.stages.length),
    [3, 4, 5],
  );
  assert.equal((await h.post('/lanes', laneFields('Incomplete', 1), { cookie })).status, 422);
  assert.equal((await h.post('/lanes', { ...laneFields('Empty SOP', 2), sop: '' }, { cookie })).status, 422);
  assert.equal(
    (await h.post('/lanes', { ...laneFields('No criteria', 2), stageCriteria1: '' }, { cookie })).status,
    422,
  );
  const lane = listLanes(h.ctxFor('alice'))[0];
  assert.ok(lane);
  const revised = laneFields('Revised sales', 3);
  revised.sop = 'New SOP';
  lane.stages.forEach((s, n) => {
    revised[`stageId${n}`] = String(s.id);
  });
  assert.equal((await h.post(`/lanes/${lane.id}`, revised, { cookie })).status, 303);
  assert.equal(listLanes(h.ctxFor('alice'))[0]?.version, 2);
  assert.equal(history(h.ctxFor('alice'), { action: 'lane.update' })[0]?.actor.name, 'alice');
  await h.restart();
  assert.deepEqual(
    listLanes(h.ctxFor('alice')).map((l) => l.stages.length),
    [3, 4, 5],
  );
  assert.equal((await h.post(`/lanes/${lane.id}/archive`, {}, { cookie })).status, 303);
  assert.equal(
    (await h.post('/cards', { title: 'Rejected', laneId: String(lane.id), summary: '', companyId: '' }, { cookie }))
      .status,
    422,
  );
});

test('R2.2/3 R3.3 HTTP board -> detail -> correction/move/attachment/archive preserves evidence and frozen markup', async (t) => {
  const h = await webTestApp(t, true);
  const { messageIds, contactId } = await ingestFixture(h);
  const cookie = h.cookieFor('alice');
  const ctx = h.ctxFor('alice');
  await h.post('/lanes', laneFields('Sales', 3), { cookie });
  await h.post('/lanes', laneFields('Finance', 5), { cookie });
  const [sales, finance] = listLanes(ctx);
  assert.ok(sales);
  assert.ok(finance?.stages[3]);
  const companyId = ensureCompany(ctx, 'Company <evidence>');
  setContactCompany(ctx, contactId, { company: { id: companyId }, evidenceMessageIds: [messageIds[0] as number] });
  const created = await h.post(
    '/cards',
    {
      title: '<script>card & title</script>',
      summary: 'Full summary <evidence>',
      laneId: String(sales.id),
      companyId: String(companyId),
    },
    { cookie },
  );
  assert.equal(created.status, 303);
  const path = created.headers.get('location') ?? '';
  const cardId = Number(path.split('/').at(-1));
  for (const messageId of messageIds)
    assert.equal(
      (
        await h.post(
          `/messages/${messageId}/attach`,
          { cardId: String(cardId), reason: 'Human evidence selection' },
          { cookie },
        )
      ).status,
      303,
    );
  const other = ensureCompany(ctx, 'Referenced company');
  const referenceId = recordReference(ctx, {
    fromCompanyId: companyId,
    toCompanyId: other,
    messageId: messageIds[0] as number,
    cardId,
  });
  assert.ok(referenceId);
  const board = await h.get('/', { cookie });
  assert.equal(board.status, 200);
  const markup = await board.text();
  assert.equal(attr(markup, 'status', 'automatic-off'), '1');
  assert.equal(attr(markup, 'my-chats', 'connected'), '1');
  assert.deepEqual(
    boardCards(markup).map((c) => [c.title, c.laneName, c.stageName]),
    [['<script>card & title</script>', 'Sales', 'Sales stage 1']],
  );
  assert.match(markup, new RegExp(`class="card-title-link" href="/cards/${cardId}"`));
  assert.match(markup, /Company &lt;evidence&gt;/);
  assert.match(markup, /Bob/);
  assert.match(markup, /alice/);
  assert.match(markup, /Last message/);
  assert.doesNotMatch(markup, /<script>card/);
  const detail = await h.get(path, { cookie });
  assert.equal(detail.status, 200);
  const detailHtml = await detail.text();
  assert.match(detailHtml, /Full summary &lt;evidence&gt;/);
  assert.match(detailHtml, /Referenced company/);
  const actual = getCard(ctx, cardId);
  assert.equal(actual.messages.length, 12);
  for (const m of actual.messages) {
    assert.match(
      detailHtml,
      new RegExp(
        `class="message" data-message-id="${m.id}" data-chat-id="${m.chatId}" data-sender-identity-id="${m.sender.identityId}"`,
      ),
    );
    assert.ok(detailHtml.includes(m.text ?? ''));
  }
  assert.ok(detailHtml.indexOf('data-message-id="1"') < detailHtml.indexOf('data-message-id="12"'));
  assert.equal(
    (
      await h.post(
        path,
        { title: 'Corrected title', summary: 'Human summary', companyId: '', reason: 'Company was wrong' },
        { cookie },
      )
    ).status,
    303,
  );
  assert.equal(
    (
      await h.post(
        `${path}/move`,
        { stageId: String(finance.stages[3].id), reason: 'Finance owns this work' },
        { cookie },
      )
    ).status,
    303,
  );
  const jordanHtml = await (await h.get('/board', { cookie: h.cookieFor('jordan') })).text();
  assert.deepEqual(
    boardCards(jordanHtml).map((c) => [c.title, c.laneName, c.stageName]),
    [['Corrected title', 'Finance', 'Finance stage 4']],
  );
  assert.equal(attr(jordanHtml, 'my-chats', 'connected'), null);
  const select =
    /<select name="stageId">([\s\S]*?)<\/select>/.exec(await (await h.get(path, { cookie })).text())?.[1] ?? '';
  assert.equal((select.match(/ selected/g) ?? []).length, 1);
  assert.equal(
    (await h.post(`/messages/${messageIds[0]}/attach`, { cardId: '', reason: 'Unrelated message' }, { cookie })).status,
    303,
  );
  assert.equal(getCard(ctx, cardId).messages.length, 11);
  assert.equal(
    (await h.post(`/references/${referenceId}/remove`, { companyId: String(other) }, { cookie })).status,
    303,
  );
  assert.equal(getCard(ctx, cardId).references.length, 0);
  assert.equal((await h.post(`${path}/archive`, {}, { cookie })).status, 303);
  assert.equal(boardCards(await (await h.get('/board', { cookie })).text()).length, 0);
  assert.equal((await h.post(`${path}/unarchive`, {}, { cookie })).status, 303);
  assert.equal(getCard(ctx, cardId).archived, false);
  assert.equal(history(ctx, { action: 'card.move' })[0]?.actor.name, 'alice');
  const fragment = await h.get('/board/fragment', { cookie });
  assert.equal(fragment.status, 200);
  const fragmentHtml = await fragment.text();
  assert.doesNotMatch(fragmentHtml, /id="status"|<!doctype/);
  assert.equal(boardCards(fragmentHtml)[0]?.title, 'Corrected title');
  assert.deepEqual(await (await h.get('/board/version', { cookie })).json(), { version: history(ctx, {})[0]?.id });
});

test('R2 truthful unknown metadata and safe typed invalid/not-found/conflict errors do not invent data', async (t) => {
  const h = await webTestApp(t);
  const cookie = h.cookieFor('alice');
  await h.post('/lanes', laneFields('Work', 2), { cookie });
  const lane = listLanes(h.ctxFor('alice'))[0];
  assert.ok(lane);
  const r = await h.post(
    '/cards',
    { title: 'Manual work', laneId: String(lane.id), summary: '', companyId: '' },
    { cookie },
  );
  const markup = await (await h.get(r.headers.get('location') ?? '', { cookie })).text();
  assert.match(markup, /Unknown/);
  assert.match(markup, /No contributing chat/);
  assert.match(markup, /No linked messages/);
  assert.equal((await h.get('/cards/nope', { cookie })).status, 422);
  assert.equal((await h.get('/cards/99999', { cookie })).status, 404);
  assert.equal((await h.post('/lanes', laneFields('Work', 2), { cookie })).status, 409);
  const bad = await h.post('/cards', { title: 'Bad', laneId: '0', summary: '', companyId: '' }, { cookie });
  assert.equal(bad.status, 422);
  assert.match(await bad.text(), /Return to board/);
});

test('R2.4 actual HTTP board renders 2000 open cards under three seconds on this development machine', async (t) => {
  const h = await webTestApp(t);
  const ctx = h.ctxFor('alice');
  const lane = createLane(ctx, {
    name: 'Synthetic scale',
    sop: 'Synthetic scale verification',
    stages: [
      { name: 'Queued', criteria: '' },
      { name: 'Verified', criteria: 'Evidence complete' },
    ],
  });
  ctx.db.tx(() => {
    for (let n = 0; n < 2000; n++)
      createCard(ctx, { laneId: lane.id, title: `Synthetic work ${n}`, summary: 'Controlled scale fixture' });
  });
  const start = performance.now();
  const response = await h.get('/board', { cookie: h.cookieFor('alice') });
  const markup = await response.text();
  const elapsed = performance.now() - start;
  assert.equal(response.status, 200);
  assert.equal(boardCards(markup).length, 2000);
  assert.ok(elapsed < 3000, `Board took ${elapsed.toFixed(1)} ms`);
  t.diagnostic(
    `Actual HTTP+HTML board elapsed ${elapsed.toFixed(1)} ms; synthetic 2000-card fixture, no browser throughput claim.`,
  );
});
