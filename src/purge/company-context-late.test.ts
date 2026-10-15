import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelDecision } from '../contracts/index.ts';
import { snapshot, withdrawalFixture } from './withdrawal-fixture.ts';

for (const outcome of ['success', 'rejection'] as const)
  for (const rollback of [false, true])
    test(`CW-R1-F1 held company input ${outcome}, ${rollback ? 'rollback' : 'commit/reinclude'}`, {
      timeout: 10000,
    }, async (t) => {
      const entered = Promise.withResolvers<void>();
      const held = Promise.withResolvers<ModelDecision>();
      let signal: AbortSignal | null = null;
      let phase = 'company';
      let companyName = '';
      let copied: ModelDecision | null = null;
      const f = await withdrawalFixture(t, {
        name: 'offline held generated-company input',
        endpointHost: null,
        blocked: null,
        async decide(input, s) {
          const none: ModelDecision = {
            disposition: 'none',
            cardId: null,
            proposalId: null,
            laneId: null,
            title: null,
            summary: null,
            cardCompanyId: null,
            cardCompanyName: null,
            confidence: 1,
            reason: 'offline held test',
            move: null,
            contacts: [],
            mentions: [],
          };
          if (phase === 'company') {
            const source = input.cards.find((c) => c.id === f.card.id);
            const participant = input.participants.find((p) => p.userKey === 'outside');
            assert.ok(source);
            assert.ok(participant);
            companyName = source.summary;
            return {
              ...none,
              contacts: [
                {
                  contactId: participant.contactId,
                  companyId: null,
                  companyName,
                  companyConfidence: 1,
                  roleCategory: null,
                  dealsAbout: null,
                  roleConfidence: 0,
                  evidenceMessageIds: [input.message.id],
                },
              ],
            };
          }
          if (phase === 'fresh') return none;
          assert.equal(input.cards.length, 0);
          assert.equal(input.proposals.length, 0);
          const company = input.companies.find((c) => c.name === companyName);
          assert.ok(company);
          copied = {
            ...none,
            disposition: 'create',
            laneId: input.lanes[0]?.id ?? null,
            title: `Late company ${company.name}`,
            summary: company.name,
          };
          signal = s;
          entered.resolve();
          return held.promise;
        },
      });
      f.h.db.run(
        "UPDATE account_chat SET sync_state='idle',sync_origin_state='none',sync_gap_from=NULL,sync_after=NULL,sync_since=NULL,sync_limit=NULL,sync_resume=NULL,sync_newest=NULL,sync_failed_since=NULL WHERE chat_id=?",
        f.chatId,
      );
      await f.h.control.advanceTo('next');
      await f.h.app.host.settle();
      const first = f.h.db.get<{ id: number }>("SELECT id FROM message WHERE message_key='key-4'")?.id;
      assert.ok(first);
      assert.equal(await f.h.app.pipeline.processNext(), first);
      f.h.db.run('UPDATE card SET archived_at=?', f.ctx.now().toISOString());
      f.h.db.run("UPDATE review_item SET status='dismissed'");
      phase = 'held';
      const second = f.h.db.run(
        "INSERT INTO message(chat_id,message_key,sender_identity_id,sent_at,text,origin,stored_at) SELECT chat_id,'held-company',sender_identity_id,sent_at,'RETAIN B input','live',stored_at FROM message WHERE id=?",
        first,
      ).lastInsertRowid;
      const work = f.h.app.pipeline.processNext();
      await entered.promise;
      assert.equal((signal as AbortSignal | null)?.aborted, false);
      if (rollback)
        f.h.db.run(
          "CREATE TRIGGER held_company_fault BEFORE DELETE ON message BEGIN SELECT RAISE(ABORT,'held company rollback'); END",
        );
      const cookie = f.h.cookieFor('alice');
      const response = await f.h.post(
        `/settings/accounts/${f.alice}/chats/${f.chatId}/withdraw`,
        { confirm: 'withdraw' },
        { cookie },
      );
      assert.equal(response.status, rollback ? 500 : 303);
      if (rollback) f.h.db.run('DROP TRIGGER held_company_fault');
      else {
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
      }
      assert.equal((signal as AbortSignal | null)?.aborted, true);
      assert.equal(await work, null);
      const beforeLate = snapshot(f.ctx);
      if (outcome === 'success') {
        assert.ok(copied);
        held.resolve(copied);
      } else held.reject(new Error('offline synthetic late rejection'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(snapshot(f.ctx), beforeLate, 'old generated-company result cannot repopulate any table');
      phase = 'fresh';
      assert.equal(await f.h.app.pipeline.processNext(), second, 'fresh successor still progresses');
      console.log(
        'COMPANY_LATE_FENCED',
        JSON.stringify({ outcome, rollback, second, aborted: (signal as AbortSignal | null)?.aborted }),
      );
    });
