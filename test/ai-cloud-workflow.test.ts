import assert from 'node:assert/strict';
import test from 'node:test';
import { cloudFixture, completed, decision, jevAnswer, jsonResponse } from '../src/agent/cloud-testing.ts';
import { getReview, listReview } from '../src/agent/index.ts';
import { createCredential, setSetting } from '../src/auth/index.ts';
import { getBoard, moveCard, updateCard } from '../src/board/index.ts';
import { history } from '../src/log/index.ts';

function open(h: Awaited<ReturnType<typeof cloudFixture>>, kind: string) {
  const r = listReview(h.ctx).find((r) => r.kind === kind);
  assert.ok(r, `Expected ${kind}`);
  return r;
}

test('cloud actual SDK transport → message → default1 HTTP review → named human acceptance → board and public MCP contact extraction', async (t) => {
  const h = await cloudFixture(t);
  h.handlers.general = async (input, request) => {
    assert.equal(request.model, 'synthetic-verbatim-model');
    assert.equal(request.store, false);
    assert.equal(request.text.format.strict, true);
    assert.equal(request.text.format.type, 'json_schema');
    assert.equal(request.input.length, 2);
    assert.doesNotMatch(request.input[0]?.content ?? '', /Synthetic integration request/);
    assert.equal(Object.hasOwn(request, 'tools'), false);
    return jsonResponse(
      completed(
        decision(input, {
          contacts: [
            {
              contactId: input.participants[0]?.contactId as number,
              companyId: null,
              companyName: 'Synthetic Acme',
              companyConfidence: 1,
              roleCategory: 'technical',
              dealsAbout: 'Integration',
              roleConfidence: 1,
              evidenceMessageIds: [input.message.id],
            },
          ],
        }),
      ),
    );
  };
  await h.deliver('one');
  assert.equal(await h.app.pipeline.drain(), 1);
  assert.equal(h.calls.length, 1, 'no destination means zero Jev HTTP');
  const review = open(h, 'new_card');
  assert.equal(review.canAccept, true);
  assert.equal((await h.get('/review')).status, 200);
  const detail = await h.get(`/review/${review.id}`);
  assert.equal(detail.status, 200);
  assert.match(await detail.text(), /Synthetic integration request/);
  assert.equal(getBoard(h.ctx).lanes[0]?.cards.length, 0);
  assert.equal((await h.post(`/review/${review.id}/accept`)).status, 303);
  assert.equal((await h.post(`/review/${review.id}/accept`)).status, 409);
  for (const kind of ['contact_company', 'contact_role'])
    assert.equal((await h.post(`/review/${open(h, kind).id}/accept`)).status, 303);
  const board = await h.get('/board');
  assert.equal(board.status, 200);
  assert.match(await board.text(), /Synthetic integration/);
  const card = getBoard(h.ctx).lanes[0]?.cards[0];
  assert.ok(card);
  assert.equal(
    history(h.ctx, { action: 'review.accept' }).every((entry) => entry.actor.name === 'Alice'),
    true,
  );
  const credential = createCredential(h.ctx, { name: 'offline reader', scopeMessages: false });
  const company = h.db.get<{ id: number }>("SELECT id FROM company WHERE name='Synthetic Acme'");
  assert.ok(company);
  const response = await h.app.fetch(
    new Request(`${h.config.origin}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'get_company',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'get_company',
          arguments: { companyId: company.id },
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'offline-cloud-test', version: '1' },
          },
        },
      }),
    }),
  );
  assert.equal(response.status, 200);
  const text = JSON.stringify(await response.json());
  assert.match(text, /Integration/);
  assert.match(text, /technical/);
  assert.doesNotMatch(text, /Synthetic integration request/);
  assert.doesNotMatch(
    JSON.stringify(h.logs),
    /synthetic-openai-secret|synthetic-jev-secret|Synthetic integration request/,
  );
  assert.equal(await h.app.pipeline.drain(), 0);
  assert.equal(h.calls.length, 1);
});

test('cloud repeat and live update attach idempotently; refill uses actual generated owner writes and keeps human text', async (t) => {
  const h = await cloudFixture(t, { threshold: 0 });
  await h.deliver('one');
  await h.app.pipeline.drain();
  const card = getBoard(h.ctx).lanes[0]?.cards[0];
  assert.ok(card);
  h.handlers.general = async (input) =>
    jsonResponse(
      completed(
        decision(input, {
          disposition: 'attach',
          cardId: card.id,
          laneId: null,
          title: null,
          summary: 'Updated generated summary',
        }),
      ),
    );
  await h.deliver('two');
  await h.app.pipeline.drain();
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM card')?.n, 1);
  assert.equal(
    h.db.get<{ summary: string }>('SELECT summary FROM card WHERE id=?', card.id)?.summary,
    'Updated generated summary',
  );
  assert.equal(await h.app.pipeline.drain(), 0);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM card_message')?.n, 2);
  updateCard(h.ctx, card.id, { title: 'Human title', summary: 'Human summary' });
  await h.deliver('three');
  await h.app.pipeline.drain();
  assert.equal(h.db.get<{ summary: string }>('SELECT summary FROM card WHERE id=?', card.id)?.summary, 'Human summary');
  assert.equal(h.calls.length, 3);
});

for (const threshold of [1, 0])
  test(`cloud Jev independent N+2 questions, prospective real-ID cross-lane human-only approval at threshold ${threshold}`, async (t) => {
    const h = await cloudFixture(t, { otherLane: true, threshold });
    let selected = '';
    h.handlers.movement = async (body) => {
      const state = JSON.parse(body.state);
      selected = state.options.find((o: { toStageId: number }) => o.toStageId === h.other?.stages[1]?.id).id;
      assert.equal(Object.keys(body.questions).length, state.options.length + 2);
      assert.match(body.questions[`support:${selected}`]?.instructions ?? '', /Payment confirmed/);
      assert.doesNotMatch(body.state, /synthetic-openai-secret|Outside|Synthetic work/);
      return jsonResponse(jevAnswer(body, selected));
    };
    await h.deliver('one');
    await h.app.pipeline.drain();
    assert.equal(h.calls.length, 2);
    const proposal = open(h, threshold === 1 ? 'new_card' : 'move');
    assert.equal(proposal.why, 'cross_lane');
    assert.equal(proposal.canAccept, true);
    if (threshold === 0) assert.equal(getBoard(h.ctx).lanes[0]?.cards.length, 1);
    assert.equal(getBoard(h.ctx).lanes[1]?.cards.length, 0);
    const audit = h.db.get<{ status: string; snapshot: string; result: string }>('SELECT * FROM movement_decision');
    assert.equal(audit?.status, 'transition');
    assert.doesNotMatch(audit?.snapshot ?? '', /Synthetic integration request|A customer requests/);
    assert.equal(JSON.parse(audit?.result ?? '{}').supportTarget, selected);
    assert.equal((await h.get(`/review/${proposal.id}`)).status, 200);
    assert.equal((await h.post(`/review/${proposal.id}/accept`)).status, 303);
    assert.equal(getBoard(h.ctx).lanes[1]?.cards[0]?.stageId, h.other?.stages[1]?.id);
  });

for (const mode of ['review', 'low', 'fail', 'wrong-evidence'] as const)
  test(`cloud Jev ${mode} creates no-target review and preserves unrelated disposition, suppressing stage movement`, async (t) => {
    const h = await cloudFixture(t, { otherLane: true, threshold: 0.8 });
    h.handlers.general = async (input) =>
      jsonResponse(
        completed(
          decision(input, {
            move: {
              toStageId: h.lane.stages[1]?.id as number,
              confidence: 1,
              criterion: 'Delivered',
              evidenceMessageIds: [input.message.id],
            },
          }),
        ),
      );
    h.handlers.movement = async (body) =>
      mode === 'fail'
        ? jsonResponse({}, 503)
        : jsonResponse(
            jevAnswer(
              body,
              mode === 'review' ? 'review' : 'stay',
              mode === 'low' ? 0.1 : 1,
              mode === 'wrong-evidence' ? 'unoffered' : undefined,
            ),
          );
    await h.deliver('one');
    await h.app.pipeline.drain();
    const card = getBoard(h.ctx).lanes[0]?.cards[0];
    assert.ok(card);
    assert.equal(card.stageId, h.lane.stages[0]?.id);
    const review = open(h, 'model_failed');
    assert.equal(review.canAccept, false);
    assert.equal((await h.post(`/review/${review.id}/accept`)).status, 409);
    assert.equal((await h.post(`/review/${review.id}/dismiss`)).status, 303);
    assert.equal(
      h.db.get<{ card_id: number }>('SELECT card_id FROM card_message')?.card_id,
      card.id,
      'dismissing a movement-only failure preserves the valid unrelated attachment',
    );
    assert.equal(h.calls.filter((c) => c.url.includes('openai')).length, 1);
  });

test('cloud review freshness refuses human-stage race and supports explicit change and dismissal', async (t) => {
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
            criterion: 'Delivered',
            evidenceMessageIds: [input.message.id],
            confidence: 1,
          },
        }),
      ),
    );
  await h.deliver('two');
  await h.app.pipeline.drain();
  const proposal = open(h, 'move');
  assert.equal(proposal.canAccept, true);
  moveCard(h.ctx, card.id, { stageId: h.lane.stages[0]?.id as number });
  assert.equal(getReview(h.ctx, proposal.id).canAccept, false);
  assert.equal((await h.post(`/review/${proposal.id}/accept`)).status, 409);
  assert.equal(
    (await h.post(`/review/${proposal.id}/change`, { to: 'stage', stageId: String(h.lane.stages[1]?.id) })).status,
    303,
  );
  const attach = open(h, 'attach');
  assert.equal((await h.post(`/review/${attach.id}/dismiss`)).status, 303);
  assert.equal(
    h.db.get<{ set_by: string }>(
      "SELECT cm.set_by FROM card_message cm JOIN message m ON m.id=cm.message_id WHERE m.message_key='two'",
    )?.set_by,
    'human',
  );
});

test('cloud open proposal join clears inherited Jev target on a failed fresh judgment; ordinary creation remains usable', async (t) => {
  const h = await cloudFixture(t, { otherLane: true });
  h.handlers.movement = async (body) => {
    const target = Object.keys(body.questions.movement?.criteria ?? {}).find((id) => id.startsWith('lane:'));
    assert.ok(target);
    return jsonResponse(jevAnswer(body, target));
  };
  await h.deliver('one');
  await h.app.pipeline.drain();
  const old = open(h, 'new_card');
  assert.equal(old.proposal.kind, 'new_card');
  assert.ok(old.proposal.kind === 'new_card' && old.proposal.move);
  h.handlers.general = async (input) =>
    jsonResponse(
      completed(
        decision(input, {
          disposition: 'join',
          proposalId: old.id,
          laneId: null,
          title: null,
          summary: 'Refreshed pending work',
        }),
      ),
    );
  h.handlers.movement = async () => jsonResponse({}, 503);
  await h.deliver('two');
  await h.app.pipeline.drain();
  const joined = open(h, 'new_card');
  assert.equal(joined.messages.length, 2);
  assert.ok(joined.proposal.kind === 'new_card');
  assert.equal(joined.proposal.move, null);
  assert.equal(joined.proposal.summary, 'Refreshed pending work');
  assert.equal((await h.post(`/review/${joined.id}/accept`)).status, 303);
  assert.equal(getBoard(h.ctx).lanes[0]?.cards.length, 1);
  assert.equal(getBoard(h.ctx).lanes[1]?.cards.length, 0);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM card_message')?.n, 2);
});

test('cloud human review refuses changed supporting context even when the trigger and target stay unchanged', async (t) => {
  const h = await cloudFixture(t);
  h.handlers.general = async (input) =>
    jsonResponse(
      completed(
        decision(
          input,
          input.message.key === 'one' ? { disposition: 'none', laneId: null, title: null, summary: null } : {},
        ),
      ),
    );
  await h.deliver('one');
  await h.app.pipeline.drain();
  await h.deliver('two');
  await h.app.pipeline.drain();
  const proposal = open(h, 'new_card');
  assert.equal(proposal.canAccept, true);
  h.db.run("UPDATE message SET version=version+1,text='Edited supporting evidence' WHERE message_key='one'");
  assert.equal(getReview(h.ctx, proposal.id).canAccept, false);
  assert.equal((await h.post(`/review/${proposal.id}/accept`)).status, 409);
  assert.equal(getBoard(h.ctx).lanes[0]?.cards.length, 0);
});

test('cloud generic cross-lane hint cannot become a target when Jev stays; unrelated card creation proceeds', async (t) => {
  const h = await cloudFixture(t, { otherLane: true, threshold: 0 });
  h.handlers.general = async (input) =>
    jsonResponse(
      completed(
        decision(input, {
          move: {
            toStageId: h.other?.stages[1]?.id as number,
            criterion: 'Untrusted general cross-lane hint',
            confidence: 1,
            evidenceMessageIds: [input.message.id],
          },
        }),
      ),
    );
  await h.deliver('one');
  await h.app.pipeline.drain();
  assert.equal(getBoard(h.ctx).lanes[0]?.cards[0]?.stageId, h.lane.stages[0]?.id);
  assert.equal(getBoard(h.ctx).lanes[1]?.cards.length, 0);
  assert.equal(
    listReview(h.ctx).some((r) => r.kind === 'move' || (r.proposal.kind === 'new_card' && r.proposal.move !== null)),
    false,
  );
  assert.equal(listReview(h.ctx).find((r) => r.kind === 'model_failed')?.reason, 'invalid_move');
});
