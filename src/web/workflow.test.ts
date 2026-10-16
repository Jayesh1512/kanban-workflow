import assert from 'node:assert/strict';
import test from 'node:test';
import { credentialForToken, getSetting, listCredentials } from '../auth/index.ts';
import {
  createCard,
  createLane,
  createWorkflowTicket,
  getCard,
  getWorkflowBoard,
  getWorkflowTicket,
  listLanes,
} from '../board/index.ts';
import { hiddenValue, ingestFixture, webTestApp } from './testing.ts';

const createFields = { title: 'Synthetic buyer', summary: '', workstream: 'buyer', nextAction: '', followUpAt: '' };
function fields(version: number, patch: Record<string, string> = {}) {
  return {
    version: String(version),
    workstream: 'buyer',
    nextAction: '',
    followUpAt: '',
    blockedReason: '',
    buyerId: '',
    ...patch,
  };
}

test('Transcript workflow setup is guarded, opt-in and idempotent; generic cards and global policy survive', async (t) => {
  const h = await webTestApp(t);
  const ctx = h.ctxFor('alice');
  const cookie = h.cookieFor('alice');
  const lane = createLane(ctx, {
    name: 'Existing sales',
    sop: 'Keep existing work',
    stages: [
      { name: 'Old queued', criteria: '' },
      { name: 'Old done', criteria: 'Confirmed' },
    ],
  });
  const old = createCard(ctx, { laneId: lane.id, title: 'Existing deal', summary: 'Keep this evidence' });
  const before = await (await h.get('/board', { cookie })).text();
  assert.match(before, /Existing deal/);
  assert.match(before, /Set up Enterprise/);
  assert.equal(getWorkflowBoard(ctx).lane, null);
  assert.equal((await h.get('/workflow/configure', { cookie })).status, 404);
  assert.equal((await h.post('/workflow/configure', {}, { cookie })).status, 422);
  assert.equal((await h.post('/workflow/configure', { confirm: 'on' }, { cookie })).status, 303);
  const configured = getWorkflowBoard(ctx);
  assert.ok(configured.lane);
  assert.equal(configured.timeZone, 'Asia/Kolkata');
  assert.equal(configured.confidenceThreshold, 0.85);
  assert.equal(getSetting(ctx.db, 'review_threshold'), 1);
  assert.equal((await h.post('/workflow/configure', { confirm: 'on' }, { cookie })).status, 303);
  assert.equal(getWorkflowBoard(ctx).lane?.id, configured.lane.id);
  assert.equal(listLanes(ctx).length, 2);
  assert.equal(getCard(ctx, old.id).summary, 'Keep this evidence');
  const after = await (await h.get('/board', { cookie })).text();
  assert.match(after, /Enterprise &amp; partnerships/);
  assert.doesNotMatch(after, /Existing deal/);
  for (const stage of ['To be started', 'Work in progress', 'Integrations', 'Blocked', 'Completed'])
    assert.ok(after.includes(stage));
  assert.match(await (await h.get(`/cards/${old.id}`, { cookie })).text(), /Edit deal/);
});

test('Transcript native lead creation/import persist actual tickets, safely refuse duplicates and filter all four workstreams', async (t) => {
  const h = await webTestApp(t);
  const ctx = h.ctxFor('alice');
  const cookie = h.cookieFor('alice');
  await h.post('/workflow/configure', { confirm: 'on' }, { cookie });
  const r = await h.post(
    '/workflow/tickets',
    {
      ...createFields,
      title: '<script>buyer & lead</script>',
      nextAction: 'Ask engineering <tomorrow>',
      followUpAt: '2026-09-02T09:00:00+05:30',
    },
    { cookie },
  );
  assert.equal(r.status, 303);
  const path = r.headers.get('location') ?? '';
  const ticket = getWorkflowTicket(ctx, Number(path.split('/').at(-1)));
  assert.equal(ticket.workflowStage, 'to_be_started');
  assert.equal(ticket.workstream, 'buyer');
  assert.equal(new Date(ticket.followUpAt ?? '').toISOString(), '2026-09-02T03:30:00.000Z');
  assert.equal(
    (await h.post('/workflow/import', { titles: 'Provider A\nProvider B', workstream: 'provider' }, { cookie })).status,
    303,
  );
  assert.equal(getWorkflowBoard(ctx).tickets.length, 3);
  for (const titles of ['provider a\nNew lead', 'Duplicate\nduplicate']) {
    assert.equal((await h.post('/workflow/import', { titles, workstream: 'others' }, { cookie })).status, 409);
    assert.equal(getWorkflowBoard(ctx).tickets.length, 3);
  }
  assert.equal((await h.post('/workflow/tickets', { ...createFields, title: 'Provider A' }, { cookie })).status, 409);
  assert.equal(
    (await h.post('/workflow/tickets', { ...createFields, followUpAt: '2026-09-02T09:00' }, { cookie })).status,
    422,
  );
  assert.equal((await h.post('/workflow/tickets', { ...createFields, workstream: 'made-up' }, { cookie })).status, 422);
  const html = await (await h.get('/board?workstream=buyer', { cookie })).text();
  assert.match(html, /&lt;script&gt;buyer &amp; lead&lt;\/script&gt;/);
  assert.match(html, /Ask engineering &lt;tomorrow&gt;/);
  assert.doesNotMatch(html, /Provider A|<script>buyer/);
  const fragment = await (await h.get('/board/fragment?workstream=provider', { cookie })).text();
  assert.match(fragment, /Provider A/);
  assert.doesNotMatch(fragment, /buyer &amp; lead|<!doctype/);
  assert.equal((await h.get('/board?workstream=unknown', { cookie })).status, 422);
  for (const workstream of ['integration', 'others'] as const)
    createWorkflowTicket(ctx, { title: `Synthetic ${workstream}`, workstream });
  await h.restart();
  assert.equal(getWorkflowBoard(h.ctxFor('alice')).tickets.length, 5);
});

test('Transcript native metadata and stage moves enforce stale versions, reason, blocker and explicit Archive/restore', async (t) => {
  const h = await webTestApp(t);
  const ctx = h.ctxFor('alice');
  const cookie = h.cookieFor('alice');
  await h.post('/workflow/configure', { confirm: 'on' }, { cookie });
  const ticket = createWorkflowTicket(ctx, { title: 'Real persisted synthetic task' });
  const path = `/cards/${ticket.card.id}`;
  let page = await (await h.get(path, { cookie })).text();
  assert.equal(Number(hiddenValue(page, 'version')), ticket.version);
  const meta = {
    nextAction: 'Call engineering',
    followUpAt: '2026-09-02T09:00:00+05:30',
    blockedReason: 'Waiting on sandbox access',
    buyerId: '<buyer-42>',
  };
  assert.equal(
    (await h.post(`/workflow/tickets/${ticket.card.id}`, fields(ticket.version, meta), { cookie })).status,
    303,
  );
  let current = getWorkflowTicket(ctx, ticket.card.id);
  assert.ok(current.version > ticket.version);
  assert.equal(current.buyerId, '<buyer-42>');
  for (const action of ['archive', 'unarchive'])
    assert.equal((await h.post(`${path}/${action}`, {}, { cookie })).status, 422);
  assert.equal(
    (await h.post(`${path}/move`, { stageId: String(current.card.stageId), reason: 'Unversioned bypass' }, { cookie }))
      .status,
    422,
  );
  assert.equal(
    (
      await h.post(
        path,
        { title: 'Stale title', summary: '', companyId: '', reason: 'Stale edit', version: String(ticket.version) },
        { cookie },
      )
    ).status,
    409,
  );
  assert.equal(getCard(ctx, ticket.card.id).title, 'Real persisted synthetic task');
  assert.equal(
    (
      await h.post(
        `/workflow/tickets/${ticket.card.id}/move`,
        {
          version: String(current.version),
          to: 'integrations',
          reason: 'Invalid evidence',
          evidenceMessageIds: '999999',
        },
        { cookie },
      )
    ).status,
    422,
  );
  assert.equal(getWorkflowTicket(ctx, ticket.card.id).version, current.version);

  const stale = await h.post(
    `/workflow/tickets/${ticket.card.id}`,
    fields(ticket.version, { nextAction: 'Stale overwrite' }),
    { cookie },
  );
  assert.equal(stale.status, 409);
  assert.match(await stale.text(), new RegExp(`href="${path}"`));
  assert.equal(getWorkflowTicket(ctx, ticket.card.id).nextAction, 'Call engineering');
  const move = (to: string, reason = 'Human confirmed this stage', version = current.version) =>
    h.post(`/workflow/tickets/${ticket.card.id}/move`, { version: String(version), to, reason }, { cookie });
  assert.equal((await move('work_in_progress', '')).status, 422);
  assert.equal((await move('work_in_progress')).status, 303);
  assert.equal((await move('completed')).status, 409);
  current = getWorkflowTicket(ctx, ticket.card.id);
  assert.equal((await move('blocked')).status, 303);
  current = getWorkflowTicket(ctx, ticket.card.id);
  assert.equal(current.workflowStage, 'blocked');
  assert.equal((await move('archive')).status, 303);
  current = getWorkflowTicket(ctx, ticket.card.id);
  assert.equal(getCard(ctx, ticket.card.id).archived, true);
  assert.equal(current.workflowStage, 'archive');
  const board = await (await h.get('/board', { cookie })).text();
  assert.doesNotMatch(board, /Real persisted synthetic task/);
  const archive = await (await h.get('/board?view=archive', { cookie })).text();
  assert.match(archive, /Real persisted synthetic task/);
  assert.equal(
    (await h.post('/workflow/import', { titles: current.card.title, workstream: 'others' }, { cookie })).status,
    409,
  );
  page = await (await h.get(path, { cookie })).text();
  assert.match(page, /Restore to stage/);
  assert.match(page, /&lt;buyer-42&gt;/);
  assert.match(page, /reference only/);
  assert.equal((await move('to_be_started', 'Explicitly resume work')).status, 303);
  assert.equal(getCard(ctx, ticket.card.id).archived, false);
  current = getWorkflowTicket(ctx, ticket.card.id);
  assert.equal(
    (
      await h.post(
        path,
        {
          title: 'Human corrected title',
          summary: 'Human summary',
          companyId: '',
          reason: 'Human correction',
          version: String(current.version),
        },
        { cookie },
      )
    ).status,
    303,
  );
  assert.equal(getCard(ctx, ticket.card.id).title, 'Human corrected title');
  assert.ok(getWorkflowTicket(ctx, ticket.card.id).version > current.version);

  const empty = createWorkflowTicket(ctx, { title: 'Needs block metadata' });
  assert.equal(
    (
      await h.post(
        `/workflow/tickets/${empty.card.id}/move`,
        { version: String(empty.version), to: 'blocked', reason: 'No reply yet' },
        { cookie },
      )
    ).status,
    422,
  );
  assert.equal(getWorkflowTicket(ctx, empty.card.id).workflowStage, 'to_be_started');
});

test('Transcript workflow card retains actual imported supporting messages, history and human attachment controls', async (t) => {
  const h = await webTestApp(t, true);
  const { messageIds } = await ingestFixture(h);
  const cookie = h.cookieFor('alice');
  const ctx = h.ctxFor('alice');
  await h.post('/workflow/configure', { confirm: 'on' }, { cookie });
  const ticket = createWorkflowTicket(ctx, { title: 'Synthetic evidence ticket' });
  assert.equal(
    (
      await h.post(
        `/messages/${messageIds[0]}/attach`,
        { cardId: String(ticket.card.id), reason: 'Included chat supports this task' },
        { cookie },
      )
    ).status,
    303,
  );
  const actual = getCard(ctx, ticket.card.id);
  assert.equal(actual.messages.length, 1);
  const html = await (await h.get(`/cards/${ticket.card.id}`, { cookie })).text();
  assert.match(html, new RegExp(`data-message-id="${messageIds[0]}"`));
  assert.match(html, /History &amp; human corrections/);
  assert.match(html, /Change linked deal/);
  assert.match(html, /Included chat supports this task/);
});

test('Transcript priorities use actual timezone dates', async (t) => {
  const h = await webTestApp(t);
  const ctx = h.ctxFor('alice');
  const cookie = h.cookieFor('alice');
  await h.post('/workflow/configure', { confirm: 'on' }, { cookie });
  createWorkflowTicket(ctx, {
    title: 'Overdue synthetic lead',
    followUpAt: '2026-08-31T20:00:00Z',
    nextAction: 'Follow up overdue lead',
  });
  createWorkflowTicket(ctx, {
    title: 'Today synthetic lead',
    followUpAt: '2026-09-01T18:00:00Z',
    nextAction: 'Ask for test result',
  });
  createWorkflowTicket(ctx, { title: 'Tomorrow in India', followUpAt: '2026-09-01T20:00:00Z' });
  const response = await h.get('/workflow/priorities', { cookie });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Asia\/Kolkata/);
  assert.match(html, /Overdue synthetic lead/);
  assert.match(html, /Today synthetic lead/);
  assert.match(html, /Tomorrow in India/);
  assert.match(html, /Ask for test result/);
  assert.ok(html.indexOf('Today synthetic lead') < html.indexOf('<h2>Upcoming'));
  assert.ok(html.indexOf('Tomorrow in India') > html.indexOf('<h2>Upcoming'));
});

test('Transcript credential write scope remains explicitly opt-in', async (t) => {
  const h = await webTestApp(t);
  const ctx = h.ctxFor('alice');
  const cookie = h.cookieFor('alice');
  let settings = await (await h.get('/settings/credentials', { cookie })).text();
  assert.match(settings, /name="scopeWrite">/);
  assert.doesNotMatch(settings, /name="scopeWrite"[^>]*checked/);
  assert.match(settings, /No external Hermis instance is confirmed connected/);
  for (const [name, scope] of [
    ['Read only synthetic', {}],
    ['Writer synthetic', { scopeWrite: 'on' }],
  ] as const) {
    assert.equal((await h.post('/settings/credentials', { name, ...scope }, { cookie })).status, 303);
    settings = await (await h.get('/settings/credentials', { cookie })).text();
    const token = /kbn_\d+_[A-Za-z0-9_-]{43}/.exec(settings)?.[0];
    assert.ok(token);
    assert.equal(credentialForToken(h.db, token)?.scopeWrite, name.startsWith('Writer'));
    assert.doesNotMatch(await (await h.get('/settings/credentials', { cookie })).text(), /kbn_\d+_/);
  }
  assert.deepEqual(
    listCredentials(ctx)
      .map((c) => c.scopeWrite)
      .sort(),
    [false, true],
  );
});
