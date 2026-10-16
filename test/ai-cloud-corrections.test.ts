import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { cloudFixture, completed, decision, jsonResponse } from '../src/agent/cloud-testing.ts';
import { getReview, listReview } from '../src/agent/index.ts';
import { addTeammate } from '../src/auth/index.ts';
import { createCard, getBoard } from '../src/board/index.ts';
import { ensureCompany, getCompany } from '../src/graph/index.ts';
import { withdrawChat } from '../src/purge/index.ts';

function required<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}

test('independent privacy: generated company name copied from another-chat role must be erased with source', async (t) => {
  const marker = 'REVIEWER_PRIVATE_COMPANY_QZX791';
  const h = await cloudFixture(t, { threshold: 0, text: marker, otherText: 'Retained benign message' });
  h.handlers.general = async (input) =>
    jsonResponse(
      completed(
        decision(input, {
          disposition: 'none',
          laneId: null,
          title: null,
          summary: null,
          contacts: [
            {
              contactId: required(input.participants.find((p) => p.userKey === 'outside')).contactId,
              companyId: null,
              companyName: null,
              companyConfidence: 0,
              roleCategory: 'technical',
              dealsAbout: input.message.text,
              roleConfidence: 1,
              evidenceMessageIds: [input.message.id],
            },
          ],
        }),
      ),
    );
  await h.deliver('one');
  await h.app.pipeline.drain();
  const account = h.db.get<{ id: number }>('SELECT id FROM channel_account')?.id;
  assert.ok(account);
  h.app.host.includeChat(h.ctx, account, 'other', { company: null, agreedWordingVersion: 1 });
  await h.app.host.settle();
  h.handlers.general = async (input) =>
    jsonResponse(
      completed(
        decision(input, {
          disposition: 'none',
          laneId: null,
          title: null,
          summary: null,
          contacts:
            input.chat.title === 'Synthetic other'
              ? [
                  {
                    contactId: required(input.participants.find((p) => p.userKey === 'outside')).contactId,
                    companyId: null,
                    companyName: required(input.participants.find((p) => p.userKey === 'outside')).dealsAbout,
                    companyConfidence: 1,
                    roleCategory: null,
                    dealsAbout: null,
                    roleConfidence: 0,
                    evidenceMessageIds: [input.message.id],
                  },
                ]
              : [],
        }),
      ),
    );
  await h.deliver('other');
  await h.app.pipeline.drain();
  const company = h.db.get<{ id: number; name: string }>('SELECT id,name FROM company WHERE name=?', marker);
  assert.ok(company);
  const source = h.db.get<{ id: number }>("SELECT id FROM chat WHERE chat_key='work'")?.id;
  const raw = h.db.get<{ raw: string }>(
    "SELECT d.raw FROM decision d JOIN message m ON m.id=d.message_id WHERE m.message_key='other'",
  )?.raw;
  assert.ok(raw && source);
  assert.ok(JSON.parse(raw).__withdrawalContext.messageIds.length > 1);
  await h.restart();
  withdrawChat(h.ctx, h.app.host, account, source);
  const visible = h.db.get('SELECT id FROM company WHERE id=?', company.id) ? getCompany(h.ctx, company.id) : null;
  h.db.run('PRAGMA wal_checkpoint(TRUNCATE)');
  console.log(
    'COMPANY_ERASURE_OBSERVED',
    JSON.stringify({
      visible,
      physicalMarker: readFileSync(h.path).includes(Buffer.from(marker)),
      remainingMessages: h.db.all('SELECT text FROM message'),
    }),
  );
  assert.equal(readFileSync(h.path).includes(Buffer.from(marker)), false);
  assert.equal(
    JSON.stringify(visible).includes(marker),
    false,
    'withdrawn producing context remains in actual Graph company',
  );
});

test('independent human freshness: stale new-card approval must not steal manually attached message', async (t) => {
  const h = await cloudFixture(t);
  await h.deliver('one');
  await h.app.pipeline.drain();
  const r = listReview(h.ctx).find((r) => r.kind === 'new_card');
  assert.ok(r);
  const msg = required(r.messages[0]);
  const bob = addTeammate(h.ctx, { username: 'bob', displayName: 'Bob', password: 'synthetic-bob-password' });
  const manual = createCard(
    { ...h.ctx, actor: { kind: 'teammate', id: bob } },
    {
      laneId: h.lane.id,
      title: 'Human selected card',
      summary: 'Human',
      chatId: r.chat?.id,
      messageId: msg.id,
      companyId: null,
      fromHistory: false,
    },
  );
  const canAccept = getReview(h.ctx, r.id).canAccept;
  const response = await h.post(`/review/${r.id}/accept`);
  console.log(
    'HUMAN_CARD_LINK_OBSERVED',
    JSON.stringify({
      canAccept,
      status: response.status,
      manualCard: manual.id,
      link: h.db.all('SELECT * FROM card_message'),
      board: getBoard(h.ctx),
    }),
  );
  assert.equal(response.status, 409, 'old proposal should refuse after human attachment');
});

for (const threshold of [0, 1])
  test(`independent semantic validation: empty-normalized company at threshold ${threshold} must yield usable review rather than crash`, async (t) => {
    const h = await cloudFixture(t, { threshold });
    h.handlers.general = async (input) =>
      jsonResponse(
        completed(
          decision(input, {
            contacts: [
              {
                contactId: required(input.participants[0]).contactId,
                companyId: null,
                companyName: 'LLC',
                companyConfidence: 1,
                roleCategory: null,
                dealsAbout: null,
                roleConfidence: 0,
                evidenceMessageIds: [input.message.id],
              },
            ],
          }),
        ),
      );
    await h.deliver('one');
    const errors: string[] = [];
    for (let i = 0; i < 2; i++)
      try {
        await h.app.pipeline.processNext();
      } catch (e) {
        errors.push(String(e));
      }
    const reviews = listReview(h.ctx);
    let status: number | null = null;
    if (threshold === 1) {
      const p = reviews.find((r) => r.kind === 'contact_company');
      assert.ok(p);
      status = (await h.post(`/review/${p.id}/accept`)).status;
    }
    console.log(
      'INVALID_COMPANY_OBSERVED',
      JSON.stringify({
        threshold,
        errors,
        calls: h.calls.length,
        status,
        reviews: reviews.map((r) => ({ kind: r.kind, canAccept: r.canAccept })),
        message: h.db.all('SELECT version,processed_version FROM message'),
        decisions: h.db.all('SELECT id FROM decision'),
      }),
    );
    if (threshold === 0)
      assert.equal(errors.length, 0, 'schema-valid companyName must be semantically refused before applying');
    else
      assert.equal(
        reviews.find((r) => r.kind === 'contact_company')?.canAccept,
        false,
        'unapplicable proposal must not advertise acceptance',
      );
  });

test('independent control: ordinary valid company applies and unrelated human company survives withdrawal', async (t) => {
  const h = await cloudFixture(t, { threshold: 0 });
  const humanCompany = ensureCompany(h.ctx, 'Human retained control');
  h.handlers.general = async (input) =>
    jsonResponse(
      completed(
        decision(input, {
          contacts: [
            {
              contactId: required(input.participants[0]).contactId,
              companyId: null,
              companyName: 'Valid synthetic business',
              companyConfidence: 1,
              roleCategory: null,
              dealsAbout: null,
              roleConfidence: 0,
              evidenceMessageIds: [input.message.id],
            },
          ],
        }),
      ),
    );
  await h.deliver('one');
  assert.ok(await h.app.pipeline.processNext());
  const generated = h.db.get<{ id: number }>("SELECT id FROM company WHERE name='Valid synthetic business'");
  assert.ok(generated);
  const account = h.db.get<{ id: number }>('SELECT id FROM channel_account')?.id;
  const source = h.db.get<{ id: number }>("SELECT id FROM chat WHERE chat_key='work'")?.id;
  assert.ok(account && source);
  withdrawChat(h.ctx, h.app.host, account, source);
  assert.equal(getCompany(h.ctx, humanCompany).name, 'Human retained control');
  assert.equal(h.db.get('SELECT id FROM company WHERE id=?', generated.id), undefined);
});
