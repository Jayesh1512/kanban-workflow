import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PgDatabase, migrate } from '../../src/platform/database.js';
import { SqlAnalysisQueue } from '../../src/workflow/analysis.js';
const url=process.env.ANALYSIS_WINDOWS_TEST_DATABASE_URL;
if(!url)throw Error('Supply a disposable empty PostgreSQL database explicitly');
const db=new PgDatabase(url);
async function seed(chatId:string){
 await db.query("INSERT INTO chats(id,kind,title,inclusion) VALUES($1,'supergroup','Synthetic window fixture','included')",[chatId]);
 await db.query("INSERT INTO messages(chat_id,id,sender_id,sent_at,text) SELECT $1,n,99,'2026-10-17T00:00:00Z',repeat('Synthetic source ',100) FROM generate_series(1,100) n",[chatId]);
 const id=randomUUID();await db.query('INSERT INTO analysis_jobs(id,chat_id,policy_version,mapping_version,dedupe_key) VALUES($1::uuid,$2,0,0,($1::uuid)::text)',[id,chatId]);
 await db.query('INSERT INTO analysis_job_messages(job_id,chat_id,message_id,message_version) SELECT $1,chat_id,id,version FROM messages WHERE chat_id=$2',[id,chatId]);return id;
}
try{
 assert.equal((await db.query("SELECT to_regclass('public.schema_migrations') name")).rows[0]?.name,null,'Use a fresh empty disposable database');await migrate(db);await db.query('INSERT INTO telegram_account(self_user_id) VALUES(99)');
 const parent=await seed('-1001'),a=new SqlAnalysisQueue(db),b=new SqlAnalysisQueue(db);
 const jobs=await Promise.all([a.claim({workerId:'one',leaseMs:60000}),b.claim({workerId:'two',leaseMs:60000})]);
 if(!jobs[0])jobs[0]=await a.claim({workerId:'one',leaseMs:60000});if(!jobs[1])jobs[1]=await b.claim({workerId:'two',leaseMs:60000});
 assert(jobs[0]&&jobs[1]);assert.notEqual(jobs[0].id,jobs[1].id);assert.notEqual(jobs[0].claimToken,jobs[1].claimToken);
 assert.equal((await db.query('SELECT last_error FROM analysis_jobs WHERE id=$1',[parent])).rows[0]?.last_error,'analysis_window_partitioned');
 const refs=(await db.query('SELECT message_id FROM analysis_job_messages WHERE job_id<>$1 ORDER BY message_id',[parent])).rows;assert.deepEqual(refs.map(r=>r.message_id),Array.from({length:100},(_,i)=>i+1));
 for(const job of jobs){assert(job);const input=await a.loadInput(job.id);assert(input.messages.reduce((n,m)=>n+m.text.length,0)<=32000);const source=(await db.query('SELECT message_id FROM analysis_job_messages WHERE job_id=$1',[job.id])).rows;assert(source.length<=20);assert(source.every(r=>input.messages.some(m=>m.id===r.message_id)));}
 const excludedParent=await seed('-1002'),writer=await db.pool.connect();let timer:ReturnType<typeof setTimeout>|null=null;
 try{
  await writer.query('BEGIN');await writer.query('SELECT id FROM chats WHERE id=-1002 FOR UPDATE');
  await Promise.race([a.claim({workerId:'during-operator-lock',leaseMs:60000}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Claim blocked behind unrelated chat lock')),3000);})]);
  await writer.query("UPDATE chats SET inclusion='excluded',policy_version=1 WHERE id=-1002");await writer.query('COMMIT');
 }finally{if(timer)clearTimeout(timer);await writer.query('ROLLBACK');writer.release();}
 await a.claim({workerId:'after-exclusion',leaseMs:60000});assert.equal((await db.query("SELECT count(*)::int n FROM analysis_jobs WHERE chat_id=-1002 AND id<>$1",[excludedParent])).rows[0]?.n,0);
 assert.equal((await db.query('SELECT status FROM analysis_jobs WHERE id=$1',[excludedParent])).rows[0]?.status,'cancelled');
 console.log(JSON.stringify({actualPostgres:true,concurrentDistinctClaims:true,all100RevisionsPreserved:true,boundedInputs:true,operatorExclusionNoDeadlock:true,noStaleChildren:true}));
}finally{await db.close();}
