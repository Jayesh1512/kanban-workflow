import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';

it('historical migration sends no intake requests, preserves tracked cards/data and stops unselected historical backfill',async()=>{
 const engine=new PGlite();
 try{
  for(const file of ['001_initial.sql','202610170001_telegram_operations.sql','202610170002_decision_origins.sql','202610170003_contact_prospects.sql'])await engine.exec(await readFile(new URL(`../../db/migrations/${file}`,import.meta.url),'utf8'));
  await engine.exec(`INSERT INTO telegram_account(self_user_id) VALUES(123);
   INSERT INTO chats(id,kind,title,inclusion) VALUES(7,'user','Already tracked','included'),(8,'user','Historical directory','included'),(9,'user','Already excluded','excluded');
   INSERT INTO tickets(chat_id,company_id,kind,lane,stage_version) VALUES(7,NULL,'contact_prospect','Work in progress',2);
   INSERT INTO messages(chat_id,id,sent_at,text) VALUES(8,1,now(),'Retain existing historical data');
   INSERT INTO analysis_jobs(chat_id,policy_version,mapping_version,dedupe_key) VALUES(8,0,0,'historical');
   INSERT INTO history_cursors(chat_id) VALUES(7),(8);
   INSERT INTO live_checkpoints(chat_id) VALUES(7),(8);
   INSERT INTO telegram_history_requests(chat_id,batch_size,remaining_batches) VALUES(7,100,2),(8,100,2);`);
  await engine.exec(await readFile(new URL('../../db/migrations/202610230001_chat_intake_approvals.sql',import.meta.url),'utf8'));
  expect((await engine.query('SELECT id,inclusion,intake_origin FROM chats ORDER BY id')).rows).toEqual([{id:7,inclusion:'included',intake_origin:'historical'},{id:8,inclusion:'undecided',intake_origin:'historical'},{id:9,inclusion:'excluded',intake_origin:'historical'}]);
  expect((await engine.query('SELECT * FROM chat_intake_requests')).rows).toHaveLength(0);
  expect((await engine.query('SELECT lane,stage_version,tracking_state FROM tickets')).rows[0]).toEqual({lane:'Work in progress',stage_version:2,tracking_state:'active'});
  expect((await engine.query('SELECT text FROM messages')).rows[0]).toEqual({text:'Retain existing historical data'});
  expect((await engine.query('SELECT status,last_error FROM analysis_jobs')).rows[0]).toEqual({status:'cancelled',last_error:'historical_chat_manual_intake'});
  expect((await engine.query('SELECT status FROM history_cursors WHERE chat_id=8')).rows[0]).toEqual({status:'paused'});
  expect((await engine.query('SELECT remaining_batches FROM telegram_history_requests WHERE chat_id=8')).rows[0]).toEqual({remaining_batches:0});
 }finally{await engine.close();}
});
