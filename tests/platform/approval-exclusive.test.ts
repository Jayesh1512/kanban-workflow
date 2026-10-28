import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import { automaticPolicy } from '../../src/shared/automatic-policy.js';

it('suspends every non-approved ticket source while retaining its stored history', async () => {
  const db = new PGlite();
  try {
    const files = (await readdir(new URL('../../db/migrations/', import.meta.url)))
      .filter(file => file.endsWith('.sql') && file < '202610270001_approval_exclusive_sources.sql').sort();
    for (const file of files) await db.exec(await readFile(new URL(`../../db/migrations/${file}`, import.meta.url), 'utf8'));
    await db.exec(`
      INSERT INTO telegram_account(self_user_id) VALUES(99);
      INSERT INTO chats(id,kind,title,inclusion,is_control) VALUES
        (-9000,'supergroup','Control','excluded',true),
        (-1001,'supergroup','Approved source','included',false),
        (-1002,'user','Automatic legacy source','included',false),
        (-1003,'user','New pending prompt','undecided',false),
        (-1004,'user','New outbound conversation','undecided',false),
        (-1005,'user','Explicitly rejected new conversation','excluded',false);
      UPDATE chats SET intake_origin='new' WHERE id IN(-1003,-1004,-1005);
      INSERT INTO tickets(chat_id,kind) VALUES(-1001,'contact_prospect'),(-1002,'contact_prospect');
      INSERT INTO messages(chat_id,id,sent_at,text) VALUES(-1001,1,now(),'Approved evidence'),(-1002,1,now(),'Stored legacy evidence');
      INSERT INTO chat_intake_requests(chat_id,policy_version,decision,control_chat_id,message_id,delivery_state,decided_message_id,decided_at)
        VALUES(-1001,0,'approved',-9000,10,'sent',11,now());
      INSERT INTO chat_intake_requests(chat_id,policy_version,decision,control_chat_id,message_id,delivery_state)
        VALUES(-1003,0,'pending',-9000,12,'sent');
      INSERT INTO chat_intake_requests(chat_id,policy_version,decision,control_chat_id,message_id,delivery_state,decided_message_id,decided_at)
        VALUES(-1005,0,'rejected',-9000,13,'sent',14,now());
      INSERT INTO history_cursors(chat_id,status) VALUES(-1001,'complete'),(-1002,'complete');
      INSERT INTO live_checkpoints(chat_id,replay_required) VALUES(-1001,true),(-1002,true);
      INSERT INTO telegram_history_requests(chat_id,batch_size,remaining_batches) VALUES(-1001,20,5),(-1002,20,5);
      INSERT INTO app_settings(key,value) VALUES('telegram:automatic-since','{"enabled":true,"revision":"old","cutoff":"2026-10-05T00:00:00Z","initialPlacement":true}');
      INSERT INTO telegram_conversation_starts(chat_id,latest_message_at) VALUES(-1003,now()),(-1004,now()),(-1005,now());
      INSERT INTO outreach_relationships(id,identity_key,kind,display_name) VALUES
        ('00000000-0000-4000-8000-000000000001','prospect:approved','contact_prospect','Approved'),
        ('00000000-0000-4000-8000-000000000002','prospect:legacy','contact_prospect','Legacy'),
        ('00000000-0000-4000-8000-000000000003','prospect:email','contact_prospect','Email');
      INSERT INTO outreach_source_threads(id,kind,source_key,chat_id,ticket_id,source_revision) SELECT
        '10000000-0000-4000-8000-000000000001','telegram','telegram:-1001',-1001,id,'a' FROM tickets WHERE chat_id=-1001;
      INSERT INTO outreach_source_threads(id,kind,source_key,chat_id,ticket_id,source_revision) SELECT
        '10000000-0000-4000-8000-000000000002','telegram','telegram:-1002',-1002,id,'b' FROM tickets WHERE chat_id=-1002;
      INSERT INTO outreach_source_threads(id,kind,source_key,source_revision) VALUES
        ('10000000-0000-4000-8000-000000000003','email_report','report:legacy','c');
      INSERT INTO outreach_relationship_sources(source_thread_id,relationship_id,enrollment_state) VALUES
        ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','active'),
        ('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002','active'),
        ('10000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000003','active');
    `);
    await db.exec(`BEGIN;${await readFile(new URL('../../db/migrations/202610270001_approval_exclusive_sources.sql', import.meta.url), 'utf8')}COMMIT;`);
    await db.exec(`BEGIN;${await readFile(new URL('../../db/migrations/202610270002_pending_new_chat_intake.sql', import.meta.url), 'utf8')}COMMIT;`);
    expect((await db.query('SELECT id::text,inclusion FROM chats WHERE id IN (-1001,-1002) ORDER BY id')).rows).toEqual([
      { id: '-1001', inclusion: 'included' }, { id: '-1002', inclusion: 'excluded' },
    ]);
    expect((await db.query('SELECT c.id::text,t.tracking_state FROM chats c JOIN tickets t ON t.chat_id=c.id ORDER BY c.id')).rows).toEqual([
      { id: '-1002', tracking_state: 'suspended' }, { id: '-1001', tracking_state: 'active' },
    ]);
    expect((await db.query('SELECT count(*)::integer AS count FROM messages')).rows).toEqual([{ count: 2 }]);
    expect((await db.query('SELECT r.display_name,rs.enrollment_state FROM outreach_relationships r JOIN outreach_relationship_sources rs ON rs.relationship_id=r.id ORDER BY r.display_name')).rows).toEqual([
      { display_name: 'Approved', enrollment_state: 'active' },
      { display_name: 'Email', enrollment_state: 'suspended' },
      { display_name: 'Legacy', enrollment_state: 'suspended' },
    ]);
    expect((await db.query("SELECT 1 FROM app_settings WHERE key='telegram:automatic-since'")).rowCount).toBe(0);
    expect((await db.query("SELECT value->>'rule' AS rule FROM app_settings WHERE key='telegram:approval-exclusive-sources'")).rows).toEqual([{ rule: 'correlated_control_reply' }]);
    const repairedChats=(await db.query('SELECT id::text,inclusion FROM chats WHERE id IN(-1003,-1004,-1005)')).rows;
    expect(repairedChats).toHaveLength(3);expect(repairedChats).toEqual(expect.arrayContaining([
      { id: '-1003', inclusion: 'undecided' }, { id: '-1004', inclusion: 'undecided' }, { id: '-1005', inclusion: 'excluded' },
    ]));
    const pendingRequests=(await db.query("SELECT c.id::text,r.delivery_state,r.message_id,r.policy_version=c.policy_version AS current_policy FROM chats c JOIN chat_intake_requests r ON r.chat_id=c.id WHERE r.decision='pending'")).rows;
    expect(pendingRequests).toHaveLength(2);expect(pendingRequests).toEqual(expect.arrayContaining([
      { id: '-1003', delivery_state: 'sent', message_id: 12, current_policy: true },
      { id: '-1004', delivery_state: 'pending', message_id: null, current_policy: true },
    ]));
    await db.query("INSERT INTO app_settings(key,value) VALUES('telegram:automatic-since','{\"enabled\":true,\"revision\":\"should-stay-disabled\",\"cutoff\":\"2026-10-05T00:00:00Z\",\"initialPlacement\":true}')");
    expect(await automaticPolicy(db as never)).toBeNull();
    await db.query(`INSERT INTO outreach_relationships(identity_key,kind,display_name) VALUES('dead-proposal','contact_prospect','Dead proposal')`);
    const relationship = (await db.query("SELECT id FROM outreach_relationships WHERE identity_key='dead-proposal'")).rows[0] as { id: string };
    const proposal = (await db.query(`INSERT INTO outreach_sales_proposals(relationship_id,idempotency_key,command_hash,target_stage,reason,origin,manifest,input_hash,context) VALUES($1,'dead-proposal','command','lead','stale','manual','{}','old','{}') RETURNING id`,[relationship.id])).rows[0] as { id: string };
    await db.query("INSERT INTO outreach_control_outbox(proposal_id,random_id,text,state) VALUES($1,991,'dead','cancelled')",[proposal.id]);
    await db.exec(`BEGIN;${await readFile(new URL('../../db/migrations/202610270003_stale_undeliverable_sales_proposals.sql', import.meta.url), 'utf8')}COMMIT;`);
    expect(((await db.query('SELECT state FROM outreach_sales_proposals WHERE id=$1',[proposal.id])).rows[0] as { state: string }).state).toBe('stale');
  } finally { await db.close(); }
}, 20_000);
