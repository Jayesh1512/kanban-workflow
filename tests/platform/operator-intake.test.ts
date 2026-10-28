import { afterEach, describe, expect, it } from 'vitest';
import type { PgDatabase } from '../../src/platform/database.js';
import { approvedChatSourceSql } from '../../src/shared/source-approval.js';
import { TelegramStore } from '../../src/telegram/store.js';
import { fixtureDatabase } from '../workflow/database.js';

describe('audited local operator intake decisions', () => {
  const close: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const item of close.splice(0).reverse()) await item(); });

  it('approves and rejects without fabricating Telegram reply identifiers', async () => {
    const db = await fixtureDatabase([new URL('../../db/migrations/202610270004_operator_intake_approvals.sql', import.meta.url)]);
    close.push(() => db.close());
    const store = new TelegramStore(db as PgDatabase, { apiId: null, apiHash: null, sessionPath: ':memory:', historyBatchSize: 10, historyMaxBatches: 1 });
    await db.query(`INSERT INTO chats(id,kind,title,inclusion,mapping_status) VALUES
      (-2001,'user','Approved operator fixture','undecided','unresolved'),
      (-2002,'user','Rejected operator fixture','undecided','unresolved')`);
    await db.query(`INSERT INTO tickets(chat_id,kind,tracking_state) VALUES
      (-2001,'contact_prospect','suspended'),(-2002,'contact_prospect','suspended')`);
    await db.query(`INSERT INTO chat_intake_requests(chat_id,policy_version) VALUES(-2001,0),(-2002,0)`);

    await store.decideIntakeManually('-2001', 'approved', 'Explicit fixture approval');
    await store.decideIntakeManually('-2002', 'rejected', 'Explicit fixture rejection');

    expect((await db.query(`SELECT c.id::text,c.inclusion,t.tracking_state FROM chats c JOIN tickets t ON t.chat_id=c.id
      WHERE c.id IN(-2001,-2002) ORDER BY c.id`)).rows).toEqual([
      { id: '-2002', inclusion: 'excluded', tracking_state: 'suspended' },
      { id: '-2001', inclusion: 'included', tracking_state: 'active' },
    ]);
    expect((await db.query(`SELECT chat_id::text,decision,decision_origin,operator_reason,message_id,decided_message_id
      FROM chat_intake_requests WHERE chat_id IN(-2001,-2002) ORDER BY chat_id`)).rows).toEqual([
      { chat_id: '-2001', decision: 'approved', decision_origin: 'operator', operator_reason: 'Explicit fixture approval', message_id: null, decided_message_id: null },
      { chat_id: '-2002', decision: 'rejected', decision_origin: 'operator', operator_reason: 'Explicit fixture rejection', message_id: null, decided_message_id: null },
    ]);
    expect((await db.query(`SELECT id::text,${approvedChatSourceSql('c')} AS approved FROM chats c WHERE id IN(-2001,-2002) ORDER BY id`)).rows).toEqual([
      { id: '-2001', approved: true }, { id: '-2002', approved: false },
    ]);
  });
});
