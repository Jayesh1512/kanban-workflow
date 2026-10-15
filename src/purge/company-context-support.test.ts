import assert from 'node:assert/strict';
import test from 'node:test';
import { attachMessage, createCard, updateCard } from '../board/index.ts';
import type { ModelDecision } from '../contracts/index.ts';
import { addCompanyAlias, recordReference } from '../graph/index.ts';
import { withdrawalFixture } from './withdrawal-fixture.ts';

for (const path of [
  'contact',
  'card',
  'generated reference',
  'human reference',
  'unrelated survivor',
  'legacy v1',
] as const)
  test(`CW-R1-F1 actual company support: ${path}`, async (t) => {
    let phase = 'link';
    let person = 0;
    let linkCard = 0;
    let calls = 0;
    const f = await withdrawalFixture(t, {
      name: 'offline actual relationship context',
      endpointHost: null,
      blocked: null,
      async decide(input) {
        calls++;
        const participant = input.participants.find((p) => p.userKey === 'outside');
        assert.ok(participant);
        person = participant.contactId;
        const company = input.companies.find((c) => c.id === f.keptCompany);
        assert.ok(company);
        const base: ModelDecision = {
          disposition: 'none',
          cardId: null,
          proposalId: null,
          laneId: null,
          title: null,
          summary: null,
          cardCompanyId: null,
          cardCompanyName: null,
          confidence: 1,
          reason: 'offline actual support',
          move: null,
          contacts: [],
          mentions: [],
        };
        if (phase === 'link') {
          if (path === 'card')
            return {
              ...base,
              disposition: 'create',
              laneId: input.lanes[0]?.id ?? null,
              title: 'Intermediate generated card',
              summary: 'Intermediate generated summary',
              cardCompanyId: company.id,
            };
          return {
            ...base,
            contacts: [
              {
                contactId: person,
                companyId: company.id,
                companyName: null,
                companyConfidence: 1,
                roleCategory: null,
                dealsAbout: null,
                roleConfidence: 0,
                evidenceMessageIds: [input.message.id],
              },
            ],
          };
        }
        assert.equal(input.proposals.length, 0);
        assert.equal(input.cards.length, path === 'card' ? 1 : 0);
        assert.ok(company.aliases.includes('RETAIN human alias'));
        return {
          ...base,
          disposition: 'create',
          laneId: input.lanes[0]?.id ?? null,
          title: `Company output ${company.name}`,
          summary: company.aliases[0] ?? company.name,
          contacts: [
            {
              contactId: person,
              companyId: null,
              companyName: null,
              companyConfidence: 0,
              roleCategory: 'technical',
              dealsAbout: `Role ${company.name}`,
              roleConfidence: 1,
              evidenceMessageIds: [input.message.id],
            },
          ],
        };
      },
    });
    addCompanyAlias(f.ctx, f.keptCompany, 'RETAIN human alias');
    // Human company is genuinely supplied, not just named in the synthetic response.
    const supplier = createCard(f.ctx, {
      laneId: f.card.laneId,
      title: 'Human company supplier',
      summary: 'Human company supplier',
      chatId: f.otherChat,
      companyId: f.keptCompany,
    });
    f.h.db.run('UPDATE card SET archived_at=? WHERE id=?', f.ctx.now().toISOString(), f.card.id);
    f.h.db.run("UPDATE review_item SET status='dismissed'");
    if (path !== 'contact')
      f.h.db.run('UPDATE card SET archived_at=? WHERE id=?', f.ctx.now().toISOString(), f.human.id);
    // For contact, the HUMAN mixed A+B card makes the producing input complete
    // and dependent; there is no legacy generated text to force unknown.
    f.h.db.run(
      "UPDATE account_chat SET sync_state='idle',sync_origin_state='none',sync_gap_from=NULL,sync_after=NULL,sync_since=NULL,sync_limit=NULL,sync_resume=NULL,sync_newest=NULL,sync_failed_since=NULL WHERE chat_id=?",
      f.chatId,
    );
    const first = f.h.db.run(
      "INSERT INTO message(chat_id,message_key,sender_identity_id,sent_at,text,origin,stored_at) SELECT chat_id,'company-support-first',sender_identity_id,sent_at,'RETAIN B input','live',stored_at FROM message WHERE id=?",
      f.other,
    ).lastInsertRowid;
    assert.equal(await f.h.app.pipeline.processNext(), first);
    const firstRaw = f.h.db.get<{ raw: string }>('SELECT raw FROM decision WHERE message_id=?', first)?.raw;
    assert.ok(firstRaw);
    const firstContext = JSON.parse(firstRaw).__withdrawalContext;
    assert.equal(firstContext.unknown, false);
    assert.equal(firstContext.chatIds.includes(f.chatId), path === 'contact');
    if (path === 'card') {
      linkCard =
        f.h.db.get<{ card_id: number }>('SELECT card_id FROM card_message WHERE message_id=?', first)?.card_id ?? 0;
      assert.ok(linkCard);
      updateCard(f.ctx, linkCard, { title: 'Protected human text', summary: 'Protected human summary' });
    }
    f.h.db.run('UPDATE card SET archived_at=? WHERE id<>?', f.ctx.now().toISOString(), linkCard);
    assert.ok(supplier.id);
    // A reference is an extra scope contributor, not an independently supplied
    // payload. Generated legacy references must not claim citation-only support.
    if (path === 'generated reference' || path === 'human reference') {
      const referenceMessage = path === 'human reference' ? f.selected[0] : first;
      assert.ok(referenceMessage);
      recordReference(path === 'generated reference' ? f.agent : f.ctx, {
        fromCompanyId: null,
        toCompanyId: f.keptCompany,
        messageId: referenceMessage,
        cardId: null,
      });
    }
    phase = 'copy';
    const second = f.h.db.run(
      "INSERT INTO message(chat_id,message_key,sender_identity_id,sent_at,text,origin,stored_at) SELECT chat_id,'company-support-second',sender_identity_id,sent_at,'RETAIN next B input','live',stored_at FROM message WHERE id=?",
      first,
    ).lastInsertRowid;
    assert.equal(await f.h.app.pipeline.processNext(), second);
    const card = f.h.db.get<{ card_id: number }>(
      'SELECT card_id FROM card_message WHERE message_id=?',
      second,
    )?.card_id;
    assert.ok(card);
    const raw = f.h.db.get<{ raw: string }>('SELECT raw FROM decision WHERE message_id=?', second)?.raw;
    assert.ok(raw);
    const context = JSON.parse(raw).__withdrawalContext;
    if (path === 'legacy v1') {
      // Compatibility fixture: genuine current pipeline outputs, with the exact
      // incomplete metadata version written by the prior source. No output or
      // independence claim is fabricated. Old v1 cannot certify company coverage.
      const legacy = JSON.parse(raw);
      legacy.__withdrawalContext.version = 1;
      f.h.db.run('UPDATE decision SET raw=? WHERE message_id=?', JSON.stringify(legacy), second);
    }
    if (path === 'contact' || path === 'human reference') {
      assert.equal(context.unknown, false, 'complete actual producing support stays exact');
      assert.ok(context.chatIds.includes(f.chatId));
    } else if (path === 'unrelated survivor') {
      assert.equal(context.unknown, false);
      assert.ok(!context.chatIds.includes(f.chatId));
    } else if (path !== 'legacy v1')
      assert.equal(context.unknown, true, 'missing current producing support remains unknown');
    if (path === 'contact') {
      // Remove all current A card support AFTER capture; only producing context
      // can account for the dependent link. Neither new output cites A.
      for (const id of f.selected) attachMessage(f.ctx, id, null);
    }
    assert.equal(
      f.h.db.get(
        'SELECT 1 FROM card_message cm JOIN message m ON m.id=cm.message_id WHERE cm.card_id=? AND m.chat_id=?',
        card,
        f.chatId,
      ),
      undefined,
    );
    const cookie = f.h.cookieFor('alice');
    for (let n = 0; n < (path === 'unrelated survivor' ? 2 : 1); n++) {
      if (n) {
        assert.equal(
          (
            await f.h.post(
              `/settings/accounts/${f.alice}/chats/include`,
              { chatKey: 'selected', company: '', agreedWordingVersion: '1' },
              { cookie },
            )
          ).status,
          303,
        );
        await f.h.app.host.settle();
        f.h.db.run(
          "INSERT INTO message(chat_id,message_key,sender_identity_id,sent_at,text,origin,stored_at,processed_version) SELECT ?,'company-second-A',sender_identity_id,sent_at,'ERASE new A input','live',stored_at,1 FROM message WHERE id=?",
          f.chatId,
          second,
        );
      }
      assert.equal(
        (
          await f.h.post(
            `/settings/accounts/${f.alice}/chats/${f.chatId}/withdraw`,
            { confirm: 'withdraw' },
            { cookie },
          )
        ).status,
        303,
      );
      assert.equal(calls, 2);
      const title: string | undefined = f.h.db.get<{ title: string }>('SELECT title FROM card WHERE id=?', card)?.title;
      const role: string | undefined = f.h.db.get<{ deals_about: string }>(
        'SELECT deals_about FROM contact WHERE id=?',
        person,
      )?.deals_about;
      assert.equal(title, path === 'unrelated survivor' ? 'Company output RETAIN human company' : '(title removed)');
      assert.equal(role, path === 'unrelated survivor' ? 'Role RETAIN human company' : '');
      assert.equal(
        f.h.db.get<{ name: string }>('SELECT name FROM company WHERE id=?', f.keptCompany)?.name,
        'RETAIN human company',
      );
      assert.equal(
        f.h.db.get<{ alias: string }>('SELECT alias FROM company_alias WHERE company_id=?', f.keptCompany)?.alias,
        'RETAIN human alias',
      );
      if (path === 'card')
        assert.equal(
          f.h.db.get<{ title: string }>('SELECT title FROM card WHERE id=?', linkCard)?.title,
          'Protected human text',
        );
      if (path === 'unrelated survivor') {
        assert.deepEqual(
          JSON.parse(f.h.db.get<{ raw: string }>('SELECT raw FROM decision WHERE message_id=?', second)?.raw ?? '{}')
            .__withdrawalContext,
          context,
        );
      }
      console.log(
        'COMPANY_SUPPORT_WITHDRAWAL',
        JSON.stringify({ path, withdrawal: n + 1, card, person, context, title, role }),
      );
    }
  });
