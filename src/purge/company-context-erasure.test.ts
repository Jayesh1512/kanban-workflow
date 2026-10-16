import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { createCard } from '../board/index.ts';
import type { ModelDecision } from '../contracts/index.ts';
import { addCompanyAlias, ensureIdentity, removeContactCompany, setContactRole } from '../graph/index.ts';
import { record } from '../log/index.ts';
import { snapshot, withdrawalFixture } from './withdrawal-fixture.ts';

// Actual two-invocation generated intermediate; no fabricated output/provenance.
for (const route of ['participant', 'card', 'named', 'alias'] as const)
  for (const fault of route === 'participant' ? ['none', 'Board output', 'Graph output'] : ['none'])
    test(`CW-R1-F1 generated company via ${route}, ${fault} → actual HTTP and physical erasure`, async (t) => {
      let phase = 'company';
      let companyName = '';
      let person = 0;
      let company = 0;
      let calls = 0;
      let target = 0;
      const f = await withdrawalFixture(t, {
        name: 'offline independent company-input copier',
        endpointHost: null,
        blocked: null,
        async decide(input) {
          calls++;
          const participant = input.participants.find((p) => p.userKey === 'outside');
          assert.ok(participant);
          person = participant.contactId;
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
            reason: 'offline synthetic input copier',
            move: null,
            contacts: [],
            mentions: [],
          };
          if (phase === 'refill')
            return {
              ...base,
              disposition: 'attach',
              cardId: target,
              title: 'Fresh retained title',
              summary: 'Fresh retained summary',
            };
          if (phase === 'company') {
            const mixed = input.cards.find((c) => c.id === f.card.id);
            assert.ok(mixed);
            companyName = mixed.summary;
            return {
              ...base,
              contacts: [
                {
                  contactId: person,
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
          assert.equal(input.cards.length, route === 'card' ? 1 : 0);
          assert.equal(input.proposals.length, 0);
          const supplied = input.companies.find((c) => c.name === companyName);
          assert.ok(supplied);
          company = supplied.id;
          assert.equal(supplied.why, route === 'card' ? 'card' : route === 'named' ? 'named' : 'participant');
          const copied = route === 'alias' ? supplied.aliases[0] : supplied.name;
          assert.ok(copied);
          return {
            ...base,
            disposition: 'create',
            laneId: input.lanes[0]?.id ?? null,
            title: `Copied company ${copied}`,
            summary: copied,
            contacts: [
              {
                contactId: person,
                companyId: null,
                companyName: null,
                companyConfidence: 0,
                roleCategory: 'technical',
                dealsAbout: copied,
                roleConfidence: 1,
                evidenceMessageIds: [input.message.id],
              },
            ],
          };
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
      const firstContext = JSON.parse(
        f.h.db.get<{ raw: string }>('SELECT raw FROM decision WHERE message_id=?', first)?.raw ?? '{}',
      ).__withdrawalContext;
      assert.ok(firstContext.chatIds.includes(f.chatId));
      // Hide the supplied source cards/review; company input remains through its actual B-only link.
      f.h.db.run('UPDATE card SET archived_at=?', f.ctx.now().toISOString());
      f.h.db.run("UPDATE review_item SET status='dismissed'");
      company =
        f.h.db.get<{ company_id: number }>(
          'SELECT company_id FROM contact_company WHERE contact_id=? AND removed=0',
          person,
        )?.company_id ?? 0;
      assert.ok(company);
      if (route === 'alias') addCompanyAlias(f.ctx, company, `Alias ${companyName}`);
      if (route === 'card' || route === 'named') {
        removeContactCompany(f.ctx, person, company);
        if (route === 'card')
          createCard(f.ctx, {
            laneId: f.card.laneId,
            title: 'RETAIN supplier card',
            summary: 'RETAIN supplier summary',
            chatId: f.otherChat,
            companyId: company,
          });
        else {
          // Actual human include/naming path; no SQL-fabricated generated intermediate.
          f.h.app.host.excludeChat(f.ctx, f.alice, 'other');
          f.h.app.host.includeChat(f.ctx, f.alice, 'other', { company: companyName, agreedWordingVersion: 1 });
          await f.h.app.host.settle();
          removeContactCompany(f.ctx, person, company);
        }
      }
      const humanIdentity = ensureIdentity(f.ctx, {
        channel: 'fixture',
        userKey: 'human-company-control',
        displayName: 'Human',
        handle: null,
      });
      const human = humanIdentity.contactId;
      assert.ok(human);
      f.h.db.run(
        'INSERT INTO chat_participant(chat_id,identity_id,first_seen_at) VALUES (?,?,?)',
        f.otherChat,
        humanIdentity.identityId,
        f.ctx.now().toISOString(),
      );
      setContactRole(f.ctx, human, {
        category: 'finance',
        dealsAbout: 'RETAIN human role',
        evidenceMessageIds: [f.other],
      });
      phase = 'copy';
      const second = f.h.db.run(
        "INSERT INTO message(chat_id,message_key,sender_identity_id,sent_at,text,origin,stored_at) SELECT chat_id,'r2-company-copy',sender_identity_id,sent_at,'RETAIN B source','live',stored_at FROM message WHERE id=?",
        first,
      ).lastInsertRowid;
      assert.equal(await f.h.app.pipeline.processNext(), second);
      const before = f.h.db.get<{ id: number; title: string; summary: string; lane_id: number; stage_id: number }>(
        'SELECT c.* FROM card c JOIN card_message cm ON cm.card_id=c.id WHERE cm.message_id=?',
        second,
      );
      assert.ok(before);
      assert.equal(before.summary, route === 'alias' ? `Alias ${companyName}` : companyName);
      target = before.id;
      const copiedLog = f.h.db.tx(() =>
        record(f.ctx, { action: 'card.note', subjectKind: 'card', subjectId: before.id, reason: before.title }),
      );
      const database = f.h.db
        .all<{ name: string; file: string }>('PRAGMA database_list')
        .find((r) => r.name === 'main')?.file;
      assert.ok(database);
      assert.ok(
        [database, `${database}-wal`, `${database}-shm`]
          .filter(existsSync)
          .some((path) => readFileSync(path).includes(Buffer.from(before.title))),
        'full escaped title physically present BEFORE',
      );
      const context = JSON.parse(
        f.h.db.get<{ raw: string }>('SELECT raw FROM decision WHERE message_id=?', second)?.raw ?? '{}',
      ).__withdrawalContext;

      assert.equal(
        f.h.db.get(
          'SELECT 1 FROM card_message cm JOIN message m ON m.id=cm.message_id WHERE cm.card_id=? AND m.chat_id=?',
          before.id,
          f.chatId,
        ),
        undefined,
      );
      if (fault !== 'none') {
        f.h.db.run(
          fault === 'Board output'
            ? `CREATE TRIGGER company_fault BEFORE UPDATE OF title ON card WHEN NEW.id=${before.id} BEGIN SELECT RAISE(ABORT,'company output fault'); END`
            : `CREATE TRIGGER company_fault BEFORE UPDATE OF deals_about ON contact WHEN NEW.id=${person} BEGIN SELECT RAISE(ABORT,'company output fault'); END`,
        );
        const original = snapshot(f.ctx);
        const failed = await f.h.post(
          `/settings/accounts/${f.alice}/chats/${f.chatId}/withdraw`,
          { confirm: 'withdraw' },
          { cookie: f.h.cookieFor('alice') },
        );
        assert.equal(failed.status, 500);
        assert.deepEqual(snapshot(f.ctx), original);
        assert.deepEqual(f.h.db.all('PRAGMA foreign_key_check'), []);
        assert.equal(f.h.db.get<{ defer_foreign_keys: number }>('PRAGMA defer_foreign_keys')?.defer_foreign_keys, 0);
        f.h.db.run('DROP TRIGGER company_fault');
      }
      const response = await f.h.post(
        `/settings/accounts/${f.alice}/chats/${f.chatId}/withdraw`,
        { confirm: 'withdraw' },
        { cookie: f.h.cookieFor('alice') },
      );
      assert.equal(response.status, 303);
      assert.equal(calls, 2, 'withdrawal starts zero model calls');
      assert.equal(f.h.db.get('SELECT id FROM message WHERE chat_id=?', f.chatId), undefined);
      const after = f.h.db.get<{
        id: number;
        title: string;
        summary: string;
        needs_text: number;
        lane_id: number;
        stage_id: number;
      }>('SELECT id,title,summary,needs_text,text_set_by,lane_id,stage_id FROM card WHERE id=?', before.id);
      const role = f.h.db.get<{ role_category: string; deals_about: string; role_set_by: string }>(
        'SELECT role_category,deals_about,role_set_by FROM contact WHERE id=?',
        person,
      );
      assert.equal(after?.title, '(title removed)');
      assert.ok(
        context.unknown || context.chatIds.includes(f.chatId),
        'generated company must not certify B-only independence',
      );
      assert.equal(after?.summary, '');
      assert.equal(after?.needs_text, 1);
      assert.equal(role?.deals_about, '');
      assert.equal(role?.role_category, 'unknown');
      assert.equal(after?.lane_id, before.lane_id);
      assert.equal(after?.stage_id, before.stage_id);
      assert.equal(
        f.h.db.get<{ title: string }>('SELECT title FROM card WHERE id=?', f.human.id)?.title,
        'RETAIN human title',
      );
      const retainedCompany = f.h.db.get<{ name: string; name_norm: string }>(
        'SELECT name,name_norm FROM company WHERE id=?',
        company,
      );
      if (route === 'participant') {
        assert.equal(retainedCompany, undefined, 'unprotected generated company must be removed');
        assert.equal(f.h.db.get('SELECT contact_id FROM contact_company WHERE company_id=?', company), undefined);
      } else if (route === 'alias') {
        assert.equal(retainedCompany?.name, `Alias ${companyName}`, 'retain the explicit human alias');
        assert.equal(
          retainedCompany?.name_norm,
          f.h.db.get<{ alias_norm: string }>('SELECT alias_norm FROM company_alias WHERE company_id=?', company)
            ?.alias_norm,
        );
      } else {
        assert.equal(retainedCompany?.name, '(name removed)', 'human-linked identity must not retain unsafe text');
        assert.equal(retainedCompany?.name_norm, `withdrawn company ${company}`);
      }
      assert.ok(f.h.db.get('SELECT id FROM message WHERE id=?', second));
      assert.equal(
        f.h.db.get<{ redacted: number }>('SELECT redacted FROM action_log WHERE id=?', copiedLog)?.redacted,
        1,
        'complete discovered subject selectors',
      );
      if (route === 'alias')
        assert.equal(
          f.h.db.get<{ alias: string }>('SELECT alias FROM company_alias WHERE company_id=?', company)?.alias,
          `Alias ${companyName}`,
        );
      assert.equal(
        Boolean(f.h.db.get('SELECT id FROM company WHERE id=?', company)),
        route !== 'participant',
        'only an explicit human alias, card or named-chat choice retains company identity',
      );
      assert.equal(f.h.db.get<{ busy: number }>('PRAGMA wal_checkpoint(TRUNCATE)')?.busy, 0);
      const files = [database, `${database}-wal`, `${database}-shm`].filter(existsSync).map((path) => ({
        path,
        bytes: readFileSync(path).length,
        outputTitlePresent: readFileSync(path).includes(Buffer.from(before.title)),
      }));
      assert.ok(files.every((r) => !r.outputTitlePresent));
      if (route !== 'alias')
        assert.ok(
          files.every((r) => !readFileSync(r.path).includes(Buffer.from(companyName))),
          'unsafe generated company name must be physically erased; human aliases are separately protected',
        );
      assert.equal(
        f.h.db.get<{ deals_about: string }>('SELECT deals_about FROM contact WHERE id=?', human)?.deals_about,
        'RETAIN human role',
      );
      console.log(
        'PHYSICAL_COMPANY_OUTPUT_ERASED',
        JSON.stringify({
          route,
          fault,
          first,
          second,
          selectedChat: f.chatId,
          retainedChat: f.otherChat,
          person,
          company,
          firstContext,
          context,
          httpStatus: response.status,
          after,
          role,
          files,
        }),
      );
      phase = 'refill';
      f.h.db.run('UPDATE message SET version=version+1 WHERE id=?', second);
      assert.equal(await f.h.app.pipeline.processNext(), second);
      assert.equal(calls, 3);
      assert.deepEqual(
        {
          ...f.h.db.get<{ title: string; summary: string; needs_text: number; lane_id: number; stage_id: number }>(
            'SELECT title,summary,needs_text,lane_id,stage_id FROM card WHERE id=?',
            target,
          ),
        },
        {
          title: 'Fresh retained title',
          summary: 'Fresh retained summary',
          needs_text: 0,
          lane_id: before.lane_id,
          stage_id: before.stage_id,
        },
      );
    });
