// Current-image deployment acceptance. Acts only on a newly bootstrapped M5 QA
// manifest; retains that project, its volumes and labelled synthetic review data.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile,writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const manifestPath=process.env.QA_M5_MANIFEST??(await readFile('/tmp/antseed-qa-m5-manifest-path','utf8')).trim();
const m=JSON.parse(await readFile(manifestPath,'utf8'));assert.match(m.project,/^antseed-qa-m5-[a-z0-9-]+$/);assert.equal(m.root,process.cwd());
assert.deepEqual(m.compose_args.slice(0,6),['docker','compose','--project-name',m.project,'--project-directory',m.root]);
const env={...process.env,...m.environment_overrides};assert(m.environment_overrides.AI_ENV_PATH.startsWith(m.directory+'/'));
const docker=(args,options={})=>{try{return execFileSync('docker',args,{cwd:m.root,env,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:120000,maxBuffer:24*1024*1024,...options});}catch{throw new Error(`Scoped M5 Docker operation failed; inspect ${m.project} privately`);}};
const compose=(...args)=>docker([...m.compose_args.slice(1),...args]);
const node=(source)=>compose('exec','-T','backend','node','--input-type=module','-e',source);
const base=`http://127.0.0.1:${m.ports.backend}`,vbase=`http://127.0.0.1:${m.ports.vikunja}`;const publicBodies=[];
async function http(path,method='GET',body){const r=await fetch(base+path,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});const text=await r.text();publicBodies.push(text);return{status:r.status,text,data:r.headers.get('content-type')?.includes('json')?JSON.parse(text):null};}
async function waitFor(predicate,label){for(let i=0;i<100;i++){try{const s=(await http('/api/status')).data;if(predicate(s))return s;}catch{}await delay(200);}throw new Error(`M5 timeout: ${label}`);}
const connected=s=>s?.components.database.state==='ready'&&s.components.vikunja.state==='ready'&&s.components.jev.code==='provider_entitlement';
await waitFor(connected,'canonical automatic bootstrap');
const bundle=()=>compose('exec','-T','backend','cat','/run/antseed/runtime.env'),originalBundle=bundle(),runtime=parse(originalBundle),ai=parse(await readFile(m.environment_overrides.AI_ENV_PATH,'utf8'));
const secrets=[...Object.entries(runtime),...Object.entries(ai)].filter(([k,v])=>/(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(k)&&v.trim()).map(([,v])=>v.trim());
const url=new URL(runtime.DATABASE_URL);url.hostname='127.0.0.1';url.port=String(m.ports.postgres);const pool=new pg.Pool({connectionString:url.toString(),connectionTimeoutMillis:3000});pool.on('error',()=>{});
const container=compose('ps','-q','backend').trim(),inspect=JSON.parse(docker(['inspect',container]))[0];assert.equal(inspect.Image,m.backend_image);assert.deepEqual(inspect.Config.Cmd,['node','dist/main.js']);assert.deepEqual(JSON.parse(docker(['image','inspect',inspect.Image]))[0].Config.Cmd,['node','dist/main.js']);
assert.equal(inspect.Config.User,'node');assert.equal(inspect.Mounts.find(x=>x.Destination==='/run/config/ai.env').RW,false);
for(const suffix of ['postgres_data','runtime_state','vikunja_files','telegram_sessions']){const v=JSON.parse(docker(['volume','inspect',`${m.project}_${suffix}`]))[0];assert.equal(v.Labels['com.docker.compose.project'],m.project);}
for(const mount of inspect.Mounts.filter(x=>x.Name))assert(mount.Name.startsWith(m.project+'_'));
for(const [port,bindings]of Object.entries(inspect.HostConfig.PortBindings))for(const b of bindings){assert.equal(b.HostIp,'127.0.0.1');assert.equal(port,'3000/tcp');}
const native=JSON.parse(node(`import{open,stat}from'node:fs/promises';import{existsSync}from'node:fs';let ro=false;try{const f=await open('/run/config/ai.env','a');await f.close();}catch(e){ro=e.code==='EROFS';}const s=await stat('/run/antseed/runtime.env');console.log(JSON.stringify({node:process.version,arch:process.arch,platform:process.platform,uid:process.getuid(),readonly:ro,credentialUid:s.uid,credentialMode:s.mode&511,defaultSessionExists:existsSync('/data/telegram/client.session')}));`));
assert.deepEqual(native,{node:'v22.23.3',arch:'arm64',platform:'linux',uid:1000,readonly:true,credentialUid:1000,credentialMode:256,defaultSessionExists:false});
assert.equal((await http('/health/live')).status,200);assert.deepEqual((await http('/health/live')).data,{status:'ok',service:'antseed-kanban'});assert.equal((await http('/health/ready')).status,503);
const initial=await waitFor(connected,'truthful current status');assert.equal(initial.accountBound,false);assert.equal(initial.telegramLogin.state,'disconnected');assert.equal(initial.components.extraction.code,'not_checked');assert.equal(initial.components.jev.code,'provider_entitlement');
const fresh=(await pool.query('SELECT (SELECT count(*)::int FROM telegram_account) account,(SELECT count(*)::int FROM analysis_jobs) jobs,(SELECT count(*)::int FROM proposals) proposals')).rows[0];
if(!m.freshBootVerified)assert.deepEqual(fresh,{account:0,jobs:0,proposals:0});else{assert.equal(fresh.account,0);assert.equal(fresh.jobs,0);}
m.freshBootVerified=true;await writeFile(manifestPath,JSON.stringify(m,null,2),{mode:0o600});
console.log('PASS fresh current Node22 canonical CMD, readonly runtime configuration, isolated volumes and truthful disconnected/provider-paused status');

const login=await fetch(vbase+'/api/v2/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:runtime.VIKUNJA_USERNAME,password:runtime.VIKUNJA_PASSWORD})});assert.equal(login.status,200);const token=(await login.json()).token;secrets.push(token);
async function vapi(path){const r=await fetch(vbase+'/api/v2'+path,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(5000)});assert.equal(r.status,200);return r.json();}
const board=(await pool.query('SELECT project_id,view_id FROM board_bindings')).rows[0];const lanes=['To be started','Work in progress','Integrations','Blocked','Archived','Completed'],workstreams=['Buyer','Provider','Integration','Others'];
const buckets=(await pool.query('SELECT lane,bucket_id FROM board_buckets')).rows,labels=(await pool.query('SELECT workstream,label_id FROM board_labels')).rows;
assert.deepEqual(buckets.map(b=>b.lane).sort(),[...lanes].sort());assert.deepEqual(labels.map(l=>l.workstream).sort(),[...workstreams].sort());
const remoteBuckets=await vapi(`/projects/${board.project_id}/views/${board.view_id}/buckets`),remoteLabels=await vapi('/labels'),view=await vapi(`/projects/${board.project_id}/views/${board.view_id}`);
for(const b of buckets){const r=remoteBuckets.items.find(x=>String(x.id)===b.bucket_id);assert.equal(r?.title,b.lane);assert.equal(remoteBuckets.items.filter(x=>x.title===b.lane).length,1);}
for(const l of labels)assert.equal(remoteLabels.items.find(x=>String(x.id)===l.label_id)?.title,l.workstream);
assert.equal(remoteLabels.items.length,4);assert.equal(String(view.default_bucket_id),buckets.find(b=>b.lane==='To be started').bucket_id);assert.equal(String(view.done_bucket_id),buckets.find(b=>b.lane==='Completed').bucket_id);assert.equal(view.filter,null);
assert.equal(compose('exec','-T','postgres','psql','-U','antseed','-d','vikunja','-At','-c',"SELECT count(*) FROM users WHERE username='antseed'").trim(),'1');
console.log('PASS actual native v2 managed six lanes/four labels/default/done/filter and single automatically bootstrapped service user');

async function connectSdk(){const c=new Client({name:'antseed-m5-canonical-qa',version:'1'});await c.connect(new StreamableHTTPClientTransport(new URL('/mcp',base)));return c;}
const decode=r=>JSON.parse(r.content[0].text);let client=await connectSdk();
const tools=(await client.listTools()).tools;assert.equal(tools.length,36);assert(!tools.some(t=>/approve|decide|move|send|login/.test(t.name)));
const companyInput={idempotencyKey:'qa-m5-company',canonicalName:'QA M5 Cedar Relay',aliases:['QA M5 Cedar'],domains:[],workstream:'Buyer',summary:'Isolated synthetic deployment acceptance dataset',buyerIds:[],providerIds:[],evidenceIds:[]};
let company=await http('/api/companies','POST',companyInput);assert.equal(company.status,200);company=company.data;assert.deepEqual((await http('/api/companies','POST',companyInput)).data,company);
const chatId='-1000000005050',sentAt='2026-10-17T10:00:00Z',text='Noor from QA M5 Cedar Relay here. Our engineers are reviewing the integration documents; testing has not started.',evidenceId=m.syntheticEvidenceId??randomUUID();
m.syntheticEvidenceId=evidenceId;await writeFile(manifestPath,JSON.stringify(m,null,2),{mode:0o600});
const snapshot={id:'990000051',kind:'user',names:['QA Noor'],usernames:[],visiblePhones:[],visibleEmails:[],observedAt:sentAt};
await pool.query("INSERT INTO chats(id,kind,title,inclusion,mapping_status,company_id) VALUES($1,'supergroup','QA M5 Cedar engineering chat','included','confirmed',$2) ON CONFLICT(id) DO NOTHING",[chatId,company.id]);
await pool.query('INSERT INTO messages(chat_id,id,sender_id,sent_at,text,sender_snapshot,peer_snapshot,forward_metadata) VALUES($1,101,990000051,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[chatId,sentAt,text,snapshot,{...snapshot,id:chatId,kind:'chat',names:['QA M5 Cedar engineering chat']},{isForwarded:false,sourceKind:'own',originPeer:null,originName:null,originDate:null,originMessageId:null}]);
await pool.query('INSERT INTO evidence(id,chat_id,message_id,message_version,excerpt,observed_at) VALUES($1,$2,101,1,$3,$4) ON CONFLICT DO NOTHING',[evidenceId,chatId,text,sentAt]);
const ensured=await http('/api/tickets','POST',{chatId});assert.equal(ensured.status,200);let ticket=ensured.data;
const contact=decode(await client.callTool({name:'create_contact',arguments:{idempotencyKey:'qa-m5-contact',telegramUserIds:['990000051'],names:['QA Noor'],usernames:[],phones:[],emails:[],affiliation:'external',evidenceIds:[evidenceId],roles:[{companyId:company.id,role:'Engineering owner',evidenceIds:[evidenceId]}]}}));assert(contact.id);
await pool.query('INSERT INTO ticket_contacts(ticket_id,contact_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[ticket.id,contact.id]);await pool.query('INSERT INTO ticket_evidence(ticket_id,evidence_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[ticket.id,evidenceId]);
for(let i=0;i<100;i++){ticket=(await http(`/api/tickets/${ticket.id}`)).data;if(ticket.vikunjaTaskId)break;await delay(200);}assert(ticket.vikunjaTaskId);
const context=decode(await client.callTool({name:'get_ticket_context',arguments:{ticketId:ticket.id}}));assert.equal(context.contacts[0].roles[0].role,'Engineering owner');assert.equal(context.messages[0].text,text);assert.equal(context.evidence[0].id,evidenceId);
const proposalInput={idempotencyKey:'qa-m5-pending',ticketId:ticket.id,expectedStageVersion:0,targetLane:'Work in progress',evidenceIds:[evidenceId],reason:'QA-authored proposal from synthetic engineering review; no inference or approval',nextAction:null};
const proposal=decode(await client.callTool({name:'propose_lane_change',arguments:proposalInput}));assert.equal(proposal.origin,'hermes');assert.equal(proposal.decision,'pending');assert.equal(proposal.applyState,'not_requested');assert.deepEqual(decode(await client.callTool({name:'propose_lane_change',arguments:proposalInput})),proposal);assert.deepEqual((await http(`/api/proposals/${proposal.id}`)).data,proposal);
async function persistentSnapshot(){const local={};for(const[k,sql]of Object.entries({tickets:'SELECT id,vikunja_task_id,lane,stage_version FROM tickets ORDER BY id',proposals:'SELECT id,decision,apply_state,target_lane FROM proposals ORDER BY id',migrations:'SELECT version,checksum FROM schema_migrations ORDER BY version',buckets:'SELECT lane,bucket_id FROM board_buckets ORDER BY lane',labels:'SELECT workstream,label_id FROM board_labels ORDER BY workstream'}))local[k]=(await pool.query(sql)).rows;const task=await vapi(`/tasks/${ticket.vikunjaTaskId}`);const grouped=await vapi(`/projects/${board.project_id}/views/${board.view_id}/buckets/tasks?filter=${encodeURIComponent(`id = ${ticket.vikunjaTaskId}`)}`);const bucket=grouped.items.find(b=>b.tasks?.some(t=>String(t.id)===ticket.vikunjaTaskId));assert(bucket);return{local,remote:{id:task.id,bucket:bucket.id,done:task.done,title:task.title,description:task.description,labels:task.labels.map(l=>l.title).sort()}};}
for(let i=0;i<100;i++){if((await vapi(`/tasks/${ticket.vikunjaTaskId}`)).description.includes('Engineering owner'))break;await delay(100);}
const before=await persistentSnapshot();assert(before.remote.description.includes('Engineering owner'));assert.equal(before.local.tickets[0].stage_version,0);assert.equal(before.local.tickets[0].lane,'To be started');assert.equal(String(before.remote.bucket),buckets.find(b=>b.lane==='To be started').bucket_id);assert.equal(before.remote.done,false);assert.deepEqual((await pool.query('SELECT count(*)::int n FROM mutations')).rows,[{n:0}]);
console.log('PASS actual29 MCP discovery, real SQL HTTP/MCP company/contact/context and idempotent pending-only proposal; actual remote unchanged');

// Actual current PID1 receives SIGTERM while an SDK domain read is blocked by a
// real SQL table lock. No test hook, image command override or client abort.
const lock=await pool.connect();await lock.query('BEGIN');await lock.query('LOCK TABLE companies IN ACCESS EXCLUSIVE MODE');let settled=false;
const held=client.callTool({name:'list_companies',arguments:{query:'QA M5 uniquely held SDK shutdown read'}}).then(()=>{settled=true;},()=>{settled=true;});
let blocked=false;
try{
  for(let i=0;i<100;i++){const r=await pool.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name='antseed-kanban' AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM companies WHERE (%'");if(r.rows.length){blocked=true;break;}await delay(20);}assert(blocked,'SDK list domain read never reached actual PG lock');assert.equal(settled,false,'SDK request finished before SIGTERM');
  docker(['kill','--signal','TERM',container]);for(let i=0;i<100&&!settled;i++)await delay(10);assert(settled,'SIGTERM did not interrupt MCP before client abort');assert.equal(JSON.parse(docker(['inspect',container]))[0].State.Running,true,'Container exited before held domain read drained');
}finally{await lock.query('COMMIT');lock.release();}
await held;for(let i=0;i<100;i++){if(!JSON.parse(docker(['inspect',container]))[0].State.Running)break;await delay(100);}assert.equal(JSON.parse(docker(['inspect',container]))[0].State.ExitCode,0);await client.close();
docker(['start',container]);await waitFor(connected,'SIGTERM restart');assert(bundle()===originalBundle,'Credential bundle changed (values withheld)');assert.deepEqual(await persistentSnapshot(),before);
console.log('PASS current LinuxNode22 canonical SIGTERM with active officialSDK/realPG read: preClose interrupts, drain completes, natural exit0 and restart retains data');

compose('up','-d');await waitFor(connected,'repeated canonical up');assert(bundle()===originalBundle,'Credential bundle changed (values withheld)');assert.deepEqual(await persistentSnapshot(),before);
compose('down');compose('up','-d');await waitFor(connected,'persistent canonical down/up');assert(bundle()===originalBundle,'Credential bundle changed (values withheld)');assert.deepEqual(await persistentSnapshot(),before);await vapi(`/projects/${board.project_id}`);
client=await connectSdk();assert.equal((await client.listTools()).tools.length,36);assert.equal(decode(await client.callTool({name:'get_proposal',arguments:{id:proposal.id}})).decision,'pending');
const retainedContext=decode(await client.callTool({name:'get_ticket_context',arguments:{ticketId:ticket.id}}));assert.equal(retainedContext.contacts[0].id,contact.id);assert.equal(retainedContext.contacts[0].roles[0].role,'Engineering owner');assert.equal(retainedContext.messages[0].text,text);assert.equal(retainedContext.evidence[0].id,evidenceId);await client.close();
console.log('PASS repeated up and actual down/up retain IDs, board, pending proposal, source/contact data, credential bundle and existing JWT signing validity');

const volume=`${m.project}_telegram_sessions`,basename='qa_m5_offline_native';
const nativeArgs=['run','--rm','--network','none','--mount',`type=volume,source=${volume},target=/data/telegram`,inspect.Image,'node','--input-type=module','-e'];
const first=`import Database from'better-sqlite3';import{TelegramClient}from'@mtcute/node';const p='/data/telegram/${basename}';const db=new Database(p+'.sqlite');db.exec('CREATE TABLE IF NOT EXISTS qa(id TEXT)');db.prepare('INSERT INTO qa VALUES(?)').run('M5-persisted');db.close();const c=new TelegramClient({apiId:1,apiHash:'QA-OFFLINE',storage:p+'.session'});await c.prepare();await c.destroy();console.log(JSON.stringify({node:process.version,arch:process.arch,uid:process.getuid(),phase:'write'}));`;
const second=`import Database from'better-sqlite3';import{TelegramClient}from'@mtcute/node';const p='/data/telegram/${basename}';const db=new Database(p+'.sqlite');if(db.prepare('SELECT id FROM qa LIMIT 1').get().id!=='M5-persisted')throw Error('native readback');db.close();const c=new TelegramClient({apiId:1,apiHash:'QA-OFFLINE',storage:p+'.session'});await c.prepare();await c.destroy();console.log(JSON.stringify({phase:'offline-reopen',ok:true}));`;
assert.equal(JSON.parse(docker([...nativeArgs,first])).node,'v22.23.3');assert.equal(JSON.parse(docker([...nativeArgs,second])).ok,true);
assert.equal(node("import{existsSync}from'node:fs';console.log(existsSync('/data/telegram/client.session')); ").trim(),'false');
assert.deepEqual((await pool.query('SELECT (SELECT count(*)::int FROM telegram_account) account,(SELECT count(*)::int FROM analysis_jobs) jobs,(SELECT count(*)::int FROM mutations) mutations')).rows[0],{account:0,jobs:0,mutations:0});
console.log('PASS two separate --network none current-image native SQLite/mtcute0.32.4 writable-session prepare/destroy/reopen; no default session/account/provider jobs');

for(const path of ['/','/api/status','/health/ready','/api/telegram/login','/api/companies','/api/contacts','/api/tickets','/api/proposals'])await http(path);
const logs=compose('logs','--no-color'),history=docker(['image','history','--no-trunc',inspect.Image]);for(const secret of secrets)assert(!(logs+history+publicBodies.join('\n')).includes(secret),'Credential found in public/log/history (value withheld)');
// Stream exported layers in memory; no image archive or credential file is written.
const scanner=`import sys,json,subprocess,tarfile,io,gzip
needles=[s.encode() for s in json.load(sys.stdin) if s]
p=subprocess.Popen(['docker','image','save',sys.argv[1]],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
hits=0
with tarfile.open(fileobj=p.stdout,mode='r|*') as archive:
 for member in archive:
  if not member.isfile(): continue
  f=io.BufferedReader(archive.extractfile(member));stream=gzip.GzipFile(fileobj=f) if f.peek(2)[:2]==b'\\x1f\\x8b' else f;tail=b''
  while True:
   chunk=stream.read(1048576)
   if not chunk: break
   data=tail+chunk;hits+=sum(s in data for s in needles);tail=data[-max(map(len,needles)):]
assert p.wait()==0 and hits==0,'Credential scan failed (contents withheld)'
print('PASS image layers zero credential matches')`;
for(const image of [inspect.Image,`${m.project}-vikunja-setup:local`]){try{execFileSync('python3',['-c',scanner,image],{input:JSON.stringify(secrets),encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:120000});}catch{throw new Error('Image layer scan failed; values withheld');}}
for(const old of m.m1Before){const now=JSON.parse(docker(['inspect',old.id]))[0];assert.deepEqual({id:now.Id,image:now.Image,startedAt:now.State.StartedAt,status:now.State.Status},old);}
assert(bundle()===originalBundle,'Credential bundle changed (values withheld)');await pool.end();
const finalContainer=compose('ps','-q','backend').trim();const evidence={result:'PASS canonical M5 deployment',source:m.source_commit,acceptedProduct:m.accepted_product,project:m.project,ports:m.ports,image:inspect.Image,finalContainer,native,managedLanes:lanes,workstreams,unmanagedNativeBuckets:remoteBuckets.items.filter(b=>!buckets.some(x=>String(b.id)===x.bucket_id)).map(b=>b.title),tools:tools.map(t=>t.name),fixture:{companyId:company.id,chatId,ticketId:ticket.id,taskId:ticket.vikunjaTaskId,contactId:contact.id,evidenceId,proposalId:proposal.id,sourceBoundary:'Manually seeded synthetic source SQL; no authenticated Telegram or inference'},pendingUnchanged:true,credentialLeakMatches:0,imagesLayerScanned:2,existingM1Untouched:true,liveTelegram:'NOT RUN',liveJevSuccess:'EXTERNALLY BLOCKED; no request',hermesModel:'NOT RERUN; accepted M4 evidence retained'};
await writeFile(m.directory+'/evidence.json',JSON.stringify(evidence,null,2),{mode:0o600});console.log(JSON.stringify(evidence));
