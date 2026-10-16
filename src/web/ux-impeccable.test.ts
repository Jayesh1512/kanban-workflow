import assert from 'node:assert/strict';
import test from 'node:test';
import { cloudFixture, completed, decision, jsonResponse } from '../agent/cloud-testing.ts';
import { getReview, listReview } from '../agent/index.ts';
import { getSetting, setSetting } from '../auth/index.ts';
import { createCard, getBoard, getCard, moveCard, updateCard } from '../board/index.ts';
import type { ReviewKind } from '../contracts/index.ts';
import { ensureCompany, getContact } from '../graph/index.ts';
import { history } from '../log/index.ts';
import { ingestFixture, webTestApp } from './testing.ts';

type Cloud = Awaited<ReturnType<typeof cloudFixture>>;
function review(h: Cloud, kind: ReviewKind) {
  const item = listReview(h.ctx).find((r) => r.kind === kind);
  assert.ok(item, `Actual ${kind} review must exist`);
  return item;
}
function primary(markup: string): string {
  return markup.split('<summary>Technical details</summary>')[0] ?? '';
}

test('UX task navigation, native secondary access and actionable first-use state keep all tools reachable', async (t) => {
  const h = await webTestApp(t);
  const cookie = h.cookieFor('alice');
  const board = await (await h.get('/board', { cookie })).text();
  const mainNav = /<nav aria-label="Main">([\s\S]*?)<\/nav>/.exec(board)?.[1] ?? '';
  assert.match(mainNav, /Pipeline/);
  assert.match(mainNav, /Review suggestions/);
  assert.match(mainNav, /Connections/);
  assert.doesNotMatch(mainNav, /Companies|Contacts|Settings/);
  assert.match(board, /No active deals yet/);
  assert.match(board, /Connect your account, then choose which chats to include/);
  assert.match(board, /<details[^>]*id="create-card"/);
  for (const path of ['/companies', '/contacts', '/search', '/log', '/lanes', '/settings'])
    assert.match(board, new RegExp(`href="${path}"`));
  assert.match(board, /<details class="workspace-menu">/);
  assert.match(board, /<label for="quick-q">Search messages/);
  assert.match(board, /action="\/logout" method="post"/);
  const connections = await (await h.get('/settings/accounts', { cookie })).text();
  assert.match(connections, /href="\/settings\/accounts" aria-current="page"/);
  assert.match(connections, /Connecting an account does not include its chats/);
  for (const path of [
    '/companies',
    '/contacts',
    '/search',
    '/log',
    '/lanes',
    '/settings/teammates',
    '/settings/credentials',
  ]) {
    const response = await h.get(path, { cookie });
    assert.equal(response.status, 200, path);
    const active = path.startsWith('/settings') ? '/settings' : path;
    assert.match(await response.text(), new RegExp(`href="${active}" aria-current="page"`));
  }
});

test('UX real pending review drives empty pipeline and concrete escaped proposal facts before technical metadata', async (t) => {
  const h = await cloudFixture(t);
  h.handlers.general = async (input) =>
    jsonResponse(
      completed(
        decision(input, {
          title: 'Orion <renewal>',
          summary: 'Buyer asked for a proposal & meeting.',
        }),
      ),
    );
  await h.deliver('one');
  await h.app.pipeline.drain();
  assert.equal(getSetting(h.db, 'review_threshold'), 1);
  const item = review(h, 'new_card');
  const board = await (await h.get('/board')).text();
  assert.match(board, /1 suggestion to review/);
  assert.match(board, /Review the waiting suggestions/);
  assert.doesNotMatch(board, /Connect your account, then choose/);
  const page = await (await h.get(`/review/${item.id}`)).text();
  const facts = primary(page);
  assert.match(facts, /<h1>Orion &lt;renewal&gt;<\/h1>/);
  assert.match(facts, /Buyer asked for a proposal &amp; meeting/);
  assert.match(facts, /Sales \/ New/);
  assert.match(facts, /Your team reviews every suggestion/);
  assert.match(page, /<button>Create deal<\/button>/);
  assert.doesNotMatch(facts, /new_card|low_confidence|Confidence:|<pre>/);
  assert.match(page, /Synthetic integration request/);
  assert.equal((await h.post(`/review/${item.id}/accept`)).status, 303);
  const card = getBoard(h.ctx).lanes[0]?.cards[0];
  assert.ok(card);
  assert.equal(card.title, 'Orion <renewal>');
  assert.equal(getCard(h.ctx, card.id).messages.length, 1);
  assert.equal(history(h.ctx, { action: 'review.accept' })[0]?.actor.name, 'Alice');
  assert.match(await (await h.get('/log')).text(), /Suggestion accepted/);
});

for (const outcome of ['new', 'existing', 'dismiss', 'no-deal'] as const)
  test(`UX real is_work decision offers explicit paths and settles ${outcome} through HTTP`, async (t) => {
    const h = await cloudFixture(t);
    const existing = createCard(h.ctx, { laneId: h.lane.id, title: 'Existing enterprise deal', summary: '' });
    h.handlers.general = async (input) =>
      jsonResponse(
        completed(
          decision(input, {
            disposition: 'none',
            laneId: null,
            title: null,
            summary: null,
          }),
        ),
      );
    await h.deliver('one');
    await h.app.pipeline.drain();
    const item = review(h, 'is_work');
    const page = await (await h.get(`/review/${item.id}`)).text();
    assert.match(page, /Create a deal/);
    assert.match(page, /Link to an existing deal/);
    assert.match(page, /Dismiss without changes/);
    assert.match(page, /Existing enterprise deal/);
    assert.doesNotMatch(primary(page), /low_confidence|is_work|Confidence:/);
    if (outcome === 'new') {
      assert.equal(
        (
          await h.post(`/review/${item.id}/change`, {
            to: 'new_card',
            laneId: String(h.lane.id),
            title: 'Human chosen deal',
            summary: 'Human summary',
            stageId: '',
          })
        ).status,
        303,
      );
      assert.equal(getBoard(h.ctx).lanes[0]?.cards.find((c) => c.title === 'Human chosen deal')?.contacts.length, 1);
    } else if (outcome === 'existing') {
      assert.equal(
        (await h.post(`/review/${item.id}/change`, { to: 'card', cardId: String(existing.id) })).status,
        303,
      );
      assert.equal(getCard(h.ctx, existing.id).messages.length, 1);
    } else if (outcome === 'dismiss') {
      assert.equal((await h.post(`/review/${item.id}/dismiss`)).status, 303);
      assert.equal(getCard(h.ctx, existing.id).messages.length, 0);
      assert.equal(history(h.ctx, { action: 'review.dismiss' })[0]?.actor.name, 'Alice');
    } else {
      if (item.canAccept) assert.match(page, /<button>Leave off pipeline<\/button>/);
      else assert.doesNotMatch(page, new RegExp(`action="/review/${item.id}/accept"`));
      assert.equal((await h.post(`/review/${item.id}/accept`)).status, item.canAccept ? 303 : 409);
      assert.equal(getCard(h.ctx, existing.id).messages.length, 0);
    }
    assert.equal(getBoard(h.ctx).lanes[0]?.cards.length, outcome === 'new' ? 2 : 1);
    if (outcome !== 'no-deal' || item.canAccept) assert.ok(!listReview(h.ctx).some((r) => r.id === item.id));
  });

test('UX attach shows actual target, current location and proposed summary; human text remains protected', async (t) => {
  const h = await cloudFixture(t, { threshold: 0 });
  await h.deliver('one');
  await h.app.pipeline.drain();
  const card = getBoard(h.ctx).lanes[0]?.cards[0];
  assert.ok(card);
  setSetting(h.ctx, 'review_threshold', 1);
  h.handlers.general = async (input) =>
    jsonResponse(
      completed(
        decision(input, {
          disposition: 'attach',
          cardId: card.id,
          laneId: null,
          title: null,
          summary: 'Generated update',
        }),
      ),
    );
  await h.deliver('two');
  await h.app.pipeline.drain();
  const item = review(h, 'attach');
  const page = primary(await (await h.get(`/review/${item.id}`)).text());
  assert.match(page, /Synthetic integration/);
  assert.match(page, /Current location/);
  assert.match(page, /Sales \/ New/);
  assert.match(page, /Generated update/);
  assert.match(page, /Human-written deal text is preserved/);
  assert.equal((await h.post(`/review/${item.id}/accept`)).status, 303);
  assert.equal(getCard(h.ctx, card.id).summary, 'Generated update');
  assert.equal(getCard(h.ctx, card.id).messages.length, 2);
  updateCard(
    h.ctx,
    card.id,
    { title: 'Human-owned deal', summary: 'Keep my summary' },
    { reason: 'Human confirmed deal text' },
  );
  await h.deliver('three');
  await h.app.pipeline.drain();
  const protectedItem = review(h, 'attach');
  const protectedPage = primary(await (await h.get(`/review/${protectedItem.id}`)).text());
  assert.match(protectedPage, /Human-owned deal/);
  assert.match(protectedPage, /Keep the current deal summary/);
  assert.doesNotMatch(protectedPage, /Generated update/);
  assert.equal((await h.post(`/review/${protectedItem.id}/accept`)).status, 303);
  assert.equal(getCard(h.ctx, card.id).summary, 'Keep my summary');
  assert.equal(getCard(h.ctx, card.id).messages.length, 3);
});

test('UX stage suggestion shows current and target location, then stale target disables approval but allows human correction', async (t) => {
  const h = await cloudFixture(t, { threshold: 0 });
  await h.deliver('one');
  await h.app.pipeline.drain();
  const card = getBoard(h.ctx).lanes[0]?.cards[0];
  assert.ok(card);
  setSetting(h.ctx, 'review_threshold', 1);
  h.handlers.general = async (input) =>
    jsonResponse(
      completed(
        decision(input, {
          disposition: 'attach',
          cardId: card.id,
          laneId: null,
          title: null,
          summary: null,
          move: {
            toStageId: h.lane.stages[1]?.id as number,
            confidence: 1,
            criterion: 'Customer confirmed delivery',
            evidenceMessageIds: [input.message.id],
          },
        }),
      ),
    );
  await h.deliver('two');
  await h.app.pipeline.drain();
  const item = review(h, 'move');
  const page = primary(await (await h.get(`/review/${item.id}`)).text());
  assert.match(page, /Current location/);
  assert.match(page, /Sales \/ New/);
  assert.match(page, /Move to/);
  assert.match(page, /Sales \/ Done/);
  assert.match(page, /Customer confirmed delivery/);
  moveCard(h.ctx, card.id, { stageId: h.lane.stages[1]?.id as number }, { reason: 'Another human completed it' });
  assert.equal(getReview(h.ctx, item.id).canAccept, false);
  const stale = await (await h.get(`/review/${item.id}`)).text();
  assert.match(stale, /This proposal cannot be accepted/);
  assert.doesNotMatch(stale, new RegExp(`action="/review/${item.id}/accept"`));
  assert.equal((await h.post(`/review/${item.id}/accept`)).status, 409);
  assert.equal(
    (await h.post(`/review/${item.id}/change`, { to: 'stage', stageId: String(h.lane.stages[0]?.id) })).status,
    303,
  );
  assert.equal(getCard(h.ctx, card.id).stageId, h.lane.stages[0]?.id);
});

for (const similar of [false, true])
  test(`UX company and role proposals expose actual facts; similar company ${similar}`, async (t) => {
    const h = await cloudFixture(t);
    if (similar) ensureCompany(h.ctx, 'Northstar Laboratories');
    h.handlers.general = async (input) =>
      jsonResponse(
        completed(
          decision(input, {
            contacts: [
              {
                contactId: input.participants[0]?.contactId as number,
                companyId: null,
                companyName: similar ? 'Northstar Laboratory' : 'Orion enterprise',
                companyConfidence: 1,
                roleCategory: 'technical',
                dealsAbout: 'Owns the integration decision',
                roleConfidence: 1,
                evidenceMessageIds: [input.message.id],
              },
            ],
          }),
        ),
      );
    await h.deliver('one');
    await h.app.pipeline.drain();
    const company = review(h, similar ? 'name_company' : 'contact_company');
    const companyPage = primary(await (await h.get(`/review/${company.id}`)).text());
    assert.match(companyPage, similar ? /Northstar Laboratory/ : /Orion enterprise/);
    assert.match(companyPage, /Outside/);
    if (similar) {
      assert.match(companyPage, /Northstar Laboratories/);
      assert.match(companyPage, /alias/);
    }
    assert.equal((await h.post(`/review/${company.id}/accept`)).status, 303);
    const role = review(h, 'contact_role');
    const rolePage = primary(await (await h.get(`/review/${role.id}`)).text());
    assert.match(rolePage, /Current role/);
    assert.match(rolePage, /Proposed role/);
    assert.match(rolePage, /technical/);
    assert.match(rolePage, /Owns the integration decision/);
    assert.equal((await h.post(`/review/${role.id}/accept`)).status, 303);
    assert.equal(
      getContact(h.ctx, role.proposal.kind === 'contact_role' ? role.proposal.contactId : 0).roleCategory,
      'technical',
    );
  });

test('UX failed and invalid suggestions never invent acceptance or success and preserve current human data', async (t) => {
  const h = await cloudFixture(t);
  h.handlers.general = async () => jsonResponse(completed({ broken: true }));
  await h.deliver('one');
  await h.app.pipeline.drain();
  const failed = review(h, 'model_failed');
  const page = await (await h.get(`/review/${failed.id}`)).text();
  assert.match(primary(page), /No applicable change is ready for approval/);
  assert.doesNotMatch(page, new RegExp(`action="/review/${failed.id}/accept"`));
  assert.equal((await h.post(`/review/${failed.id}/accept`)).status, 409);
  assert.equal((await h.post(`/review/${failed.id}/change`, { to: 'card', cardId: '999999' })).status, 404);
  assert.equal(getBoard(h.ctx).lanes[0]?.cards.length, 0);
  assert.equal((await h.post(`/review/${failed.id}/dismiss`)).status, 303);
  assert.match(await (await h.get('/review')).text(), /All suggestions reviewed/);
  assert.equal((await h.get('/review/999999')).status, 404);
});

for (const gateway of [false, true])
  test(`UX settings distinguish configured from working and name the actual allowed route; gateway ${gateway}`, async (t) => {
    const h = await cloudFixture(t, { gateway });
    const page = await (await h.get('/settings')).text();
    assert.match(page, /Configured means server settings are present/);
    assert.match(page, /successful access is not verified here/);
    assert.match(
      page,
      new RegExp(
        `<dt>Allowed Jev destination</dt><dd>${gateway ? 'ai-gateway.vercel.sh/typesafe/v1/systemone' : 'api.typesafe.ai/v1/systemone'}</dd>`,
      ),
    );
    assert.doesNotMatch(
      page,
      /synthetic-openai-secret|synthetic-jev-secret|synthetic-gateway-secret|free-tier|paid credits/,
    );
    assert.match(page, /Advanced team settings/);
    assert.match(page, /id="review-threshold"/);
    assert.equal(h.calls.length, 0);
  });

test('UX stale new deal evidence retains current human work and exposes no acceptance control', async (t) => {
  const h = await cloudFixture(t);
  await h.deliver('one');
  await h.app.pipeline.drain();
  const item = review(h, 'new_card');
  const card = createCard(h.ctx, { laneId: h.lane.id, title: 'Current deal', summary: 'Human facts' });
  updateCard(h.ctx, card.id, { title: 'Current human title' }, { reason: 'Confirmed current title' });
  assert.equal(
    (await h.post(`/messages/${item.messages[0]?.id}/attach`, { cardId: String(card.id), reason: 'Human selection' }))
      .status,
    303,
  );
  assert.equal(getReview(h.ctx, item.id).canAccept, false);
  const page = await (await h.get(`/review/${item.id}`)).text();
  assert.doesNotMatch(page, new RegExp(`action="/review/${item.id}/accept"`));
  assert.equal((await h.post(`/review/${item.id}/accept`)).status, 409);
  assert.equal(getCard(h.ctx, card.id).title, 'Current human title');
  assert.equal(getCard(h.ctx, card.id).messages.length, 1);
});

test('UX personal chat choices show current inclusion and retain stored evidence on exclusion with owner guards', async (t) => {
  const h = await webTestApp(t, true);
  const { accountId, messageIds } = await ingestFixture(h);
  const alice = h.cookieFor('alice');
  const jordan = h.cookieFor('jordan');
  const path = `/settings/accounts/${accountId}/chats`;
  const page = await (await h.get(path, { cookie: alice })).text();
  assert.match(page, /1 of 2 chats included/);
  assert.match(page, /Included/);
  assert.match(page, /Message content stays private until you include a chat/);
  assert.match(page, /Excluding stops ingestion and keeps stored messages/);
  assert.match(page, /App-wide cleanup: across OTHER chats too/);
  assert.match(page, /href="\/settings\/accounts" aria-current="page"/);
  assert.doesNotMatch(await (await h.get('/settings/accounts', { cookie: jordan })).text(), /Acme integration/);
  assert.equal((await h.get(path, { cookie: jordan })).status, 403);
  assert.equal((await h.post(`${path}/exclude`, { chatKey: 'client' }, { cookie: jordan })).status, 403);
  assert.equal((await h.post(`${path}/exclude`, { chatKey: 'client' }, { cookie: alice })).status, 303);
  assert.match(await (await h.get(path, { cookie: alice })).text(), /0 of 2 chats included/);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM message')?.n, messageIds.length);
});

test('UX missing configuration offers settings recovery without disabling manual pipeline use or inventing provider success', async (t) => {
  const h = await cloudFixture(t, { missingModel: true, missingMovement: true });
  const page = await (await h.get('/board')).text();
  assert.match(page, /Server configuration is missing/);
  assert.match(page, /Check AI settings/);
  assert.match(page, /Create a deal manually/);
  const result = await h.post('/cards', {
    title: 'Manual enterprise deal',
    laneId: String(h.lane.id),
    summary: 'Human facts',
    companyId: '',
  });
  assert.equal(result.status, 303);
  assert.match(await (await h.get(result.headers.get('location') ?? '')).text(), /Manual enterprise deal/);
  assert.equal(h.calls.length, 0);
});

test('UX similar-company dismissal names its real separate-company consequences and applies them through HTTP', async (t) => {
  const h = await cloudFixture(t);
  ensureCompany(h.ctx, 'Northstar Laboratories');
  h.handlers.general = async (input) =>
    jsonResponse(
      completed(
        decision(input, {
          contacts: [
            {
              contactId: input.participants[0]?.contactId as number,
              companyId: null,
              companyName: 'Northstar Laboratory',
              companyConfidence: 1,
              roleCategory: null,
              dealsAbout: '',
              roleConfidence: 0,
              evidenceMessageIds: [input.message.id],
            },
          ],
        }),
      ),
    );
  await h.deliver('one');
  await h.app.pipeline.drain();
  const item = review(h, 'name_company');
  const page = await (await h.get(`/review/${item.id}`)).text();
  assert.match(page, /<button class="secondary">Keep companies separate<\/button>/);
  assert.match(page, /Held contact links are applied to a separate company/);
  assert.equal((await h.post(`/review/${item.id}/dismiss`)).status, 303);
  assert.ok(item.proposal.kind === 'name_company');
  const held = item.proposal.held.find((use) => use.use === 'contact_company');
  assert.ok(held?.use === 'contact_company');
  assert.ok(getContact(h.ctx, held.contactId).companies.some((co) => co.name === 'Northstar Laboratory'));
  assert.equal(history(h.ctx, { action: 'review.dismiss' })[0]?.actor.name, 'Alice');
});
