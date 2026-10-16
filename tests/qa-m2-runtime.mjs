// Actual QA-owned Compose runtime only. No account login, provider request or Telegram send.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import pg from 'pg';
const manifest=JSON.parse(readFileSync(process.env.QA_M2_MANIFEST ?? readFileSync('/tmp/antseed-qa-m1-manifest-path','utf8').trim(),'utf8'));
const project=manifest.project;
assert(/^antseed-qa-m1-[a-z0-9-]+$/.test(project),'Require the retained QA-owned isolated Compose project');
const environment={...process.env,...manifest.environment_overrides};
assert(resolve(environment.AI_ENV_PATH).startsWith(resolve(manifest.directory)+'/'),'Require the QA synthetic env override');
const synthetic=parse(readFileSync(environment.AI_ENV_PATH,'utf8'));
assert(!synthetic.TELEGRAM_API_ID?.trim()&&!synthetic.TELEGRAM_API_HASH?.trim(),'No custom real Telegram credential in runtime test');
const run=(args)=>execFileSync(args[0],args.slice(1),{cwd:manifest.root,env:environment,encoding:'utf8',stdio:['pipe','pipe','pipe']});
const compose=(...args)=>run([...manifest.compose_args,...args]);
const bundle=()=>compose('exec','-T','backend','cat','/run/antseed/runtime.env');
const initialBundle=bundle(),runtime=parse(initialBundle);
const secrets=[...Object.entries(runtime),...Object.entries(synthetic)].filter(([k,v])=>/(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(k)&&v.trim()).map(([,v])=>v.trim());
assert.equal(compose('exec','-T','backend','node','-e',"console.log(require('node:fs').existsSync('/data/telegram/client.session'))").trim(),'false','No default session to restore');
const uri=new URL(runtime.DATABASE_URL);uri.hostname='127.0.0.1';uri.port=String(manifest.ports.postgres);
const pool=new pg.Pool({connectionString:uri.toString(),connectionTimeoutMillis:3000});
pool.on('error',()=>{}); // Expected idle-session errors during this explicit QA-owned outage.
const before=(await pool.query("SELECT EXISTS(SELECT 1 FROM telegram_account) account,(SELECT count(*)::int FROM analysis_jobs WHERE status IN ('pending','running','retry')) jobs,(SELECT count(*)::int FROM proposals WHERE decision='approved') approvals")).rows[0];
assert.deepEqual(before,{account:false,jobs:0,approvals:0},'Runtime must be disconnected with no provider/apply work');
// Remote board is authoritative: previously human-moved M1 tasks may legitimately
// update their stale local mirror when the newly composed projector first observes them.
const vikunja=`http://127.0.0.1:${manifest.ports.vikunja}`;
const login=await fetch(`${vikunja}/api/v2/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:runtime.VIKUNJA_USERNAME,password:runtime.VIKUNJA_PASSWORD})});
assert.equal(login.status,200,'QA local Vikunja login');const token=(await login.json()).token;secrets.push(token);
const binding=(await pool.query('SELECT project_id,view_id FROM board_bindings')).rows[0];
const initialBucket=String((await pool.query("SELECT bucket_id FROM board_buckets WHERE lane='To be started'")).rows[0].bucket_id);
async function remoteLanes(){const r=await fetch(`${vikunja}/api/v2/projects/${binding.project_id}/views/${binding.view_id}/buckets/tasks`,{headers:{authorization:`Bearer ${token}`}});assert.equal(r.status,200);const json=await r.json();return json.items.flatMap(b=>(b.tasks??[]).map(t=>({id:String(t.id),bucket:String(b.id),done:t.done}))).sort((a,b)=>a.id.localeCompare(b.id));}
const beforeRemote=await remoteLanes();assert(beforeRemote.length>0,'Require retained synthetic remote tasks for the lane guard');
const base=`http://127.0.0.1:${manifest.ports.backend}`;const bodies=[];
async function request(path,method='GET',body){const r=await fetch(base+path,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});const raw=await r.text();bodies.push(raw);return{status:r.status,headers:r.headers,raw,data:r.headers.get('content-type')?.includes('json')?JSON.parse(raw):null};}
async function waitReadyDatabase(){for(let n=0;n<100;n++){try{const r=await request('/api/status');if(r.status===200&&r.data.components.database.state==='ready')return r.data;}catch{}await new Promise(r=>setTimeout(r,200));}throw Error('QA canonical DB did not become ready');}
const uid=randomUUID(),chatId=`-${parseInt(uid.replaceAll('-','').slice(0,10),16)}`;let companyId,inserted=false;
try{
  compose('up','-d','--no-deps','backend');const status=await waitReadyDatabase();
  const container=compose('ps','-q','backend').trim(),inspection=JSON.parse(run(['docker','inspect',container]))[0];
  assert.equal(inspection.Config.Labels['com.docker.compose.project'],project);assert.deepEqual(inspection.Config.Cmd,['node','dist/main.js']);
  for(const m of inspection.Mounts.filter(m=>m.Name))assert(m.Name.startsWith(project+'_'));
  assert.equal(inspection.Mounts.find(m=>m.Destination==='/run/config/ai.env').RW,false);
  assert.equal((await request('/health/live')).status,200);assert.deepEqual((await request('/health/live')).data,{status:'ok',service:'antseed-kanban'});
  const ready=await request('/health/ready');assert.equal(ready.status,503);assert.deepEqual(ready.data.modules.map(m=>m.name),['platform','workflow']);
  assert.equal(status.accountBound,false);assert.equal(status.configuration.telegramConfigured,true);assert.equal(status.telegramLogin.state,'disconnected');
  for(const provider of ['extraction','jev'])assert.equal(status.components[provider].code,'not_checked');
  assert.equal((await request('/')).status,200);assert.equal((await request('/api/chats')).status,200);
  assert.equal((await request('/api/telegram/login','POST',{step:'code',code:''})).status,400);
  assert.equal((await request('/api/telegram/control-setup','POST',{operationKey:`qa-no-login-${uid}`,chatId:'-1000000000042'})).status,503);
  companyId=(await pool.query("INSERT INTO companies(canonical_name) VALUES($1) RETURNING id",[`QA HTTP synthetic ${uid}`])).rows[0].id;
  await pool.query("INSERT INTO chats(id,kind,title,inclusion) VALUES($1,'supergroup',$2,'included')",[chatId,`QA HTTP synthetic ${uid}`]);inserted=true;
  await pool.query('INSERT INTO history_cursors(chat_id) VALUES($1)',[chatId]);await pool.query('INSERT INTO live_checkpoints(chat_id) VALUES($1)',[chatId]);await pool.query('INSERT INTO telegram_history_requests(chat_id,batch_size,remaining_batches) VALUES($1,2,2)',[chatId]);
  const exclusion=await request(`/api/chats/${chatId}/inclusion`,'PUT',{expectedPolicyVersion:0,inclusion:'excluded',idempotencyKey:`exclude-${uid}`});assert.equal(exclusion.status,200);assert.equal(exclusion.data.policyVersion,1);
  assert.equal((await request(`/api/chats/${chatId}/inclusion`,'PUT',{expectedPolicyVersion:0,inclusion:'included',idempotencyKey:`old-${uid}`})).status,409);
  const mapping=await request(`/api/chats/${chatId}/mapping`,'PUT',{expectedMappingVersion:0,status:'confirmed',companyId,evidenceIds:[],reason:'QA explicit correction',source:'analysis',idempotencyKey:`map-${uid}`});assert.equal(mapping.status,200);
  assert.equal((await pool.query('SELECT source FROM mapping_history WHERE chat_id=$1',[chatId])).rows[0].source,'http');
  assert.equal((await request(`/api/chats/${chatId}/mapping`)).status,200);
  const historyStatus=await request(`/api/chats/${chatId}/import`);assert.equal(historyStatus.status,200);assert.equal(historyStatus.data.status,'paused');
  assert.equal((await request(`/api/chats/${chatId}/import`,'POST',{maxBatches:1,batchSize:1,idempotencyKey:`import-${uid}`})).status,409);
  assert.equal(compose('exec','-T','backend','node','-e',"console.log(require('node:fs').existsSync('/data/telegram/client.session'))").trim(),'false');
  console.log('PASS actual canonical CMD/platform+workflow health, default-profile fresh boot, six chat routes, no account action');
  // Restart reuses credentials and migrations; API fixtures never contain a message or analysis job.
  compose('stop','-t','15','backend');const stopped=JSON.parse(run(['docker','inspect',container]))[0];assert.equal(stopped.State.ExitCode,0,'Graceful canonical shutdown');
  run(['docker','start',container]);await waitReadyDatabase();assert(bundle()===initialBundle,'Persisted credential bundle changed (contents withheld)');
  console.log('PASS graceful shutdown/restart with persisted credentials and disconnected session');
  compose('stop','postgres');try{
    assert.equal((await request('/health/live')).status,200);assert.equal((await request('/')).status,200);
    const unavailable=await request('/api/status');assert.equal(unavailable.status,200);assert.equal(unavailable.data.components.database.state,'unavailable');assert.equal((await request('/health/ready')).status,503);
  }finally{compose('start','postgres');}
  await waitReadyDatabase();assert.equal((await request('/health/live')).status,200);
  console.log('PASS actual PG outage keeps UI/liveness responsive; recovery retains migration/account truth');
  const afterRemote=await remoteLanes();for(const task of beforeRemote)assert.deepEqual(afterRemote.find(t=>t.id===task.id),task,'Existing remote lane/done unchanged without approval');for(const task of afterRemote.filter(t=>!beforeRemote.some(b=>b.id===t.id)))assert.deepEqual({bucket:task.bucket,done:task.done},{bucket:initialBucket,done:false},'New projection starts only in initial lane');
  const image=inspection.Image,volume=inspection.Mounts.find(m=>m.Destination==='/data/telegram').Name;
  const basename=`qa_native_${uid.replaceAll('-','')}`;
  const nativeArgs=['docker','run','--rm','--network','none','--mount',`type=volume,source=${volume},target=/data/telegram`,'-e',`QA_NATIVE_BASENAME=${basename}`,image,'node','--input-type=module','-e'];
  const first=`import Database from 'better-sqlite3';import {TelegramClient} from '@mtcute/node';const p='/data/telegram/'+process.env.QA_NATIVE_BASENAME;const db=new Database(p+'.sqlite');db.exec('CREATE TABLE qa(id TEXT)');db.prepare('INSERT INTO qa VALUES(?)').run('persisted');db.close();const c=new TelegramClient({apiId:1,apiHash:'QA-OFFLINE',storage:p+'.session'});await c.prepare();await c.destroy();console.log('PASS native first write '+process.version+' '+process.arch);`;
  const second=`import Database from 'better-sqlite3';import {TelegramClient} from '@mtcute/node';import{readdir,rm}from'node:fs/promises';const b=process.env.QA_NATIVE_BASENAME,p='/data/telegram/'+b;const db=new Database(p+'.sqlite');if(db.prepare('SELECT id FROM qa').get().id!=='persisted')throw Error('readback');db.close();const c=new TelegramClient({apiId:1,apiHash:'QA-OFFLINE',storage:p+'.session'});await c.prepare();await c.destroy();for(const f of await readdir('/data/telegram'))if(f.startsWith(b))await rm('/data/telegram/'+f);console.log('PASS native offline reopen and exact synthetic-file cleanup');`;
  console.log(run([...nativeArgs,first]).trim());console.log(run([...nativeArgs,second]).trim());
  const logs=compose('logs','--no-color','backend'),history=run(['docker','image','history','--no-trunc',image]);
  for(const value of secrets)assert(!(bodies.join('\n')+logs+history).includes(value),'Credential match (value withheld)');
  assert(bundle()===initialBundle,'Persisted credential bundle changed (contents withheld)');assert.equal((await pool.query('SELECT * FROM telegram_account')).rowCount,0);
  console.log('PASS runtime/public/log/image-history credential scan; no automatic lane change or Telegram account created');
  console.log(`QA M2 runtime image ${image}; project ${project}`);
}finally{
  // Restart even when an assertion interrupts an outage, and remove only this route fixture.
  try{compose('start','postgres');}catch{}
  if(inserted){for(const table of ['mapping_history','telegram_history_requests','history_cursors','live_checkpoints'])await pool.query(`DELETE FROM ${table} WHERE chat_id=$1`,[chatId]);await pool.query('DELETE FROM chats WHERE id=$1',[chatId]);}
  if(companyId)await pool.query('DELETE FROM companies WHERE id=$1',[companyId]);await pool.query('DELETE FROM idempotency_keys WHERE key=ANY($1::text[])',[[`exclude-${uid}`,`old-${uid}`,`map-${uid}`,`import-${uid}`]]);await pool.end();
}
