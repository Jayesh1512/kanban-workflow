import { afterEach, expect, it } from 'vitest';
import { ANALYSIS_WINDOW_CHARACTERS, partitionAnalysisSources } from '../../src/shared/analysis-windows.js';
import { SqlAnalysisQueue } from '../../src/workflow/analysis.js';
import { jobId } from '../intelligence/fixtures.js';
import { fixtureDatabase } from './database.js';
import { fixtureMessage, telegramFixture } from '../platform/telegram-fixture.js';
const cleanup: Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
it('partitions all original source revisions including long Unicode messages without loss or duplication',()=>{
 const rows=Array.from({length:100},(_,i)=>({id:i+1,version:1,text:i%3===0?'🙂'.repeat(8000):'source '.repeat(500)})),windows=partitionAnalysisSources(rows);
 expect(windows.flat()).toEqual(rows);expect(new Set(windows.flat().map(r=>r.id)).size).toBe(100);
 for(const w of windows){expect(w.length).toBeLessThanOrEqual(20);expect(w.reduce((n,r)=>n+r.text.slice(0,8000).length,0)).toBeLessThanOrEqual(ANALYSIS_WINDOW_CHARACTERS);}
});
it('ingestion snapshots every message into bounded jobs, dedupes replay and invalidates only the edited source window',async()=>{
 const f=await telegramFixture();cleanup.push(()=>f.db.close());await f.store.upsertDialog({id:'-10042',kind:'supergroup',title:'Synthetic batch',username:null,archived:false});
 const messages=Array.from({length:100},(_,i)=>fixtureMessage(i+1,'-10042','Synthetic source '.repeat(100))),before=await f.store.getLiveCheckpoint('-10042');
 const page=await f.store.commitReplay({chatId:'-10042',expectedPolicyVersion:0,expectedGeneration:before.generation,messages,highWaterMessageId:100});
 const ids=(await f.db.query('SELECT message_id FROM analysis_job_messages ORDER BY message_id')).rows.map(r=>r.message_id);expect(ids).toEqual(Array.from({length:100},(_,i)=>i+1));
 const windows=(await f.db.query('SELECT job_id,count(*)::int n,sum(LEAST(length(m.text),8000))::int chars FROM analysis_job_messages s JOIN messages m ON (m.chat_id,m.id)=(s.chat_id,s.message_id) GROUP BY job_id')).rows;
 expect(windows.length).toBeGreaterThan(1);expect(windows.every(r=>Number(r.n)<=20&&Number(r.chars)<=16000)).toBe(true);
 await f.store.commitReplay({chatId:'-10042',expectedPolicyVersion:0,expectedGeneration:page.generation,messages,highWaterMessageId:100});expect((await f.db.query('SELECT id FROM analysis_jobs')).rows).toHaveLength(windows.length);
 await f.store.ingest({type:'edit',message:{...messages[99]!,text:'Corrected source '.repeat(100),editedAt:'2026-10-23T00:00:00Z'}});
 expect((await f.db.query("SELECT id FROM analysis_jobs WHERE status='cancelled'")).rows).toHaveLength(1);
 expect((await f.db.query('SELECT id FROM analysis_jobs')).rows).toHaveLength(windows.length+1);
});
async function legacy(){const db=await fixtureDatabase();cleanup.push(()=>db.close());await db.query("INSERT INTO messages(chat_id,id,sender_id,sent_at,text) SELECT -1001,n,7,'2026-10-16T20:00:00Z','Synthetic legacy source' FROM generate_series(2,100) n");await db.query('INSERT INTO analysis_job_messages(job_id,chat_id,message_id,message_version) SELECT $1,chat_id,id,version FROM messages WHERE id>1',[jobId]);return db;}
it('repartitions a legacy 100-message job atomically, preserving every revision and the original queue age',async()=>{
 const db=await legacy(),queue=new SqlAnalysisQueue(db);const original=(await db.query('SELECT created_at FROM analysis_jobs WHERE id=$1',[jobId])).rows[0]!.created_at;
 const job=await queue.claim({workerId:'repair',leaseMs:60000});expect(job).not.toBeNull();expect((await db.query('SELECT status,last_error FROM analysis_jobs WHERE id=$1',[jobId])).rows[0]).toMatchObject({status:'cancelled',last_error:'analysis_window_partitioned'});
 const children=(await db.query('SELECT id,created_at FROM analysis_jobs WHERE id<>$1',[jobId])).rows;expect(children).toHaveLength(5);expect(children.every(r=>String(r.created_at)===String(original))).toBe(true);
 const refs=(await db.query('SELECT message_id FROM analysis_job_messages WHERE job_id<>$1 ORDER BY message_id',[jobId])).rows.map(r=>r.message_id);expect(refs).toEqual(Array.from({length:100},(_,i)=>i+1));
 const input=await queue.loadInput(job!.id);expect(input.messages.length).toBeLessThanOrEqual(40);expect((await db.query('SELECT message_id FROM analysis_job_messages WHERE job_id=$1',[job!.id])).rows.every(r=>input.messages.some(m=>m.id===r.message_id))).toBe(true);
});
it('retains upstream retry deadlines when splitting a delayed job',async()=>{
 const db=await legacy();let now=new Date();const retryAt=new Date(now.getTime()+3600000),queue=new SqlAnalysisQueue(db,{now:()=>now});await db.query("UPDATE analysis_jobs SET status='retry',retry_at=$1",[retryAt]);
 expect(await queue.claim({workerId:'repair',leaseMs:60000})).toBeNull();const rows=(await db.query('SELECT retry_at FROM analysis_jobs WHERE id<>$1',[jobId])).rows;expect(rows).toHaveLength(5);expect(rows.every(r=>new Date(r.retry_at as string).getTime()===retryAt.getTime())).toBe(true);
 now=new Date(retryAt.getTime()+1);expect(await queue.claim({workerId:'after-wait',leaseMs:60000})).not.toBeNull();
});
it('never revives obsolete or excluded source revisions during automatic repartition',async()=>{
 const db=await legacy();await db.query("UPDATE chats SET inclusion='excluded',policy_version=policy_version+1");const queue=new SqlAnalysisQueue(db);expect(await queue.claim({workerId:'repair',leaseMs:60000})).toBeNull();expect((await db.query('SELECT id FROM analysis_jobs')).rows).toHaveLength(1);expect((await db.query('SELECT status,last_error FROM analysis_jobs')).rows[0]).toMatchObject({status:'cancelled',last_error:'source_changed'});
});
