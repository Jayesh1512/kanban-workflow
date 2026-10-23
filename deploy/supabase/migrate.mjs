import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { parse } from 'dotenv';
import { privateWrite } from './configure.mjs';

export const CLIENT_IMAGE='postgres:17.11-bookworm@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826';
// Supabase can default extra_float_digits to 0, while local PostgreSQL uses 1.
// Canonicalize presentation, not data: floating-point bytes must remain exact.
export const SNAPSHOT_SETTINGS="SET timezone='UTC'; SET extra_float_digits=3;";
const schemas=['antseed','vikunja'];
const ident=s=>'"'+s.replaceAll('"','""')+'"';
async function run(args,{input,output,env}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn('docker',args,{stdio:['pipe','pipe','pipe'],env:{...process.env,...env}});let text='',overflow=false;
  let sink;if(output){sink=createWriteStream(output,{flags:'wx',mode:0o600});child.stdout.pipe(sink);sink.on('error',()=>{child.kill();reject(new Error('Database command output could not be saved privately'));});}
  else child.stdout.on('data',d=>{if(text.length<16*1024*1024)text+=d;else overflow=true;});
  child.stderr.resume(); // Never echo database CLI diagnostics or private connection details.
  if(input){const source=createReadStream(input);source.on('error',()=>child.kill());source.pipe(child.stdin);}else child.stdin.end();
  child.stdin.on('error',()=>{});child.on('error',()=>reject(new Error('Docker database command could not start')));
  child.on('close',code=>{const done=()=>code===0&&!overflow?resolve(text):reject(new Error('Database command failed; local source data is preserved'));
   if(sink&&!sink.writableFinished)sink.once('finish',done);else done();});
 });
}
const snapshotSql=schema=>`SELECT json_build_object('tables',COALESCE((SELECT json_agg(json_build_object('name',tablename,'fingerprint',NULL) ORDER BY tablename) FROM pg_tables WHERE schemaname='${schema}'),'[]'::json),'sequences',COALESCE((SELECT json_agg(sequencename ORDER BY sequencename) FROM pg_sequences WHERE schemaname='${schema}'),'[]'::json));`;
// Per-table row digests are ordered before aggregation; no private values leave
// PostgreSQL. Counts alone would miss changed approvals/message revisions.
export async function snapshot(query,schema){
 const catalog=JSON.parse((await query(snapshotSql(schema))).trim());const tables=[];
 for(const t of catalog.tables){const name=ident(schema)+'.'+ident(t.name);
  const value=JSON.parse((await query(`SELECT json_build_object('count',count(*),'digest',md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),''))) FROM ${name} t;`)).trim());tables.push({name:t.name,...value});}
 const sequences=[];for(const name of catalog.sequences){const value=JSON.parse((await query(`SELECT json_build_object('last',last_value::text,'called',is_called) FROM ${ident(schema)}.${ident(name)};`)).trim());sequences.push({name,...value});}
 return {tables,sequences};
}
async function targetConfig(directory){
 const values=parse(await readFile(join(directory,'database.env')));let url;
 try{url=new URL(values.SUPABASE_DATABASE_URL);}catch{throw new Error('Prepare the private Supabase configuration first');}
 if(url.port==='6543')throw new Error('Use a direct/session connection, not transaction pooling');
 if(url.searchParams.has('sslrootcert'))url.searchParams.set('sslrootcert',join(directory,'database-ca.crt'));
 return url;
}
async function target(directory){
 const url=await targetConfig(directory);const pool=new pg.Pool({connectionString:url.toString(),max:2,connectionTimeoutMillis:15000,query_timeout:120000,onConnect:client=>client.query(SNAPSHOT_SETTINGS)});pool.on('error',()=>{});
 return {pool,query:async sql=>JSON.stringify((await pool.query(sql)).rows[0]?.value??null)};
}
async function targetSnapshot(pool,schema){return snapshot(async sql=>{const r=await pool.query(sql);return JSON.stringify(Object.values(r.rows[0])[0]);},schema);}
async function preflight(directory){
 const {pool}=await target(directory);let a,b;
 try{
  a=await pool.connect();b=await pool.connect();const version=Number((await a.query('SHOW server_version_num')).rows[0].server_version_num);
  if(version<170000)throw new Error('This migration uses PostgreSQL 17 backups; use a Supabase project on PostgreSQL 17 or newer');
  const key=`antseed:supabase-preflight:${randomUUID()}`;
  await a.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[key]);
  try{await a.query('SELECT 1');const r=await b.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[key]);
   if(r.rows[0].acquired){await b.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);throw new Error('Session advisory locks were not retained; choose Session pooler instead of transaction pooling');}
  }finally{await a.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);}
  console.log(JSON.stringify({connection:'ready',sessionLocks:'verified',postgresMajor:Math.floor(version/10000),schemas}));
 }finally{a?.release();b?.release();await pool.end();}
}
async function backup(project,directory){
 if(!/^[a-z0-9][a-z0-9_-]*$/.test(project??''))throw new Error('Specify the exact source Compose project with --project');
 await mkdir(directory,{recursive:true,mode:0o700});
 try{await readFile(join(directory,'manifest.json'));throw new Error('Specify a fresh backup directory; an existing backup will not be overwritten');}catch(error){if(error.code!=='ENOENT')throw error;}
 const compose=['compose','-p',project,'-f','compose.yaml'];
 const statuses=await run([...compose,'ps','--all','--format','json','backend','vikunja']);
 const rows=statuses.trim()?statuses.trim().split('\n').flatMap(line=>{const row=JSON.parse(line);return Array.isArray(row)?row:[row];}):[];
 if(rows.length!==2||rows.some(r=>r.State!=='exited'))throw new Error('Stop only the source backend and Vikunja before a coherent backup; PostgreSQL must stay running');
 const manifest={project,createdAt:new Date().toISOString(),schemas:{}};
 for(const schema of schemas){
  const temporary=join(directory,`${schema}.source.dump.partial`),final=join(directory,`${schema}.source.dump`);
  await run([...compose,'exec','-T','postgres','pg_dump','-U','antseed','-d',schema,'--format=custom','--no-owner','--no-privileges'],{output:temporary});await rename(temporary,final);
  const query=sql=>run([...compose,'exec','-T','postgres','psql','-X','-v','ON_ERROR_STOP=1','-U','antseed','-d',schema,'-Atc',`${SNAPSHOT_SETTINGS} ${sql}`]).then(s=>s.replace(/^(?:SET\n)+/,''));
  manifest.schemas[schema]=await snapshot(query,'public');
 }
 await privateWrite(join(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 console.log(JSON.stringify({backup:'complete',project,schemas,credentialsPrinted:false}));
}
async function stage(directory){
 const name=`antseed-supabase-stage-${randomUUID().slice(0,12)}`;
 await run(['run','-d','--name',name,'--label','antseed.migration=supabase-stage','--network','none','--tmpfs','/var/lib/postgresql/data','-e','POSTGRES_HOST_AUTH_METHOD=trust',CLIENT_IMAGE]);
 try{
  let ready=false;for(let attempt=0;attempt<30;attempt++){try{await run(['exec',name,'pg_isready','-U','postgres']);ready=true;break;}catch{await new Promise(r=>setTimeout(r,500));}}
  if(!ready)throw new Error('Private staging PostgreSQL did not start');
  for(const schema of schemas){
   await run(['exec',name,'createdb','-U','postgres',schema]);
   await run(['exec','-i',name,'pg_restore','-U','postgres','-d',schema,'--no-owner','--no-privileges','--exit-on-error'],{input:join(directory,`${schema}.source.dump`)});
   await run(['exec',name,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d',schema,'-c',`ALTER SCHEMA public RENAME TO ${ident(schema)}`]);
   const temporary=join(directory,`${schema}.supabase.dump.partial`);
   await run(['exec',name,'pg_dump','-U','postgres','-d',schema,'--format=custom','--no-owner','--no-privileges',`--schema=${schema}`],{output:temporary});await rename(temporary,join(directory,`${schema}.supabase.dump`));
  }
 }finally{await run(['rm','-f',name]);}
 console.log('Private schema-remapped archives prepared; no target writes made.');
}
async function clientArgs(config,directory){
 const url=await targetConfig(config),password=decodeURIComponent(url.password);
 const escape=s=>s.replaceAll('\\','\\\\').replaceAll(':','\\:');
 const passfile=join(directory,'.target.pgpass');await privateWrite(passfile,[url.hostname,url.port||'5432',decodeURIComponent(url.pathname.slice(1)),decodeURIComponent(url.username),password].map(escape).join(':')+'\n');
 const args=['run','--rm','-i','--label','antseed.migration=supabase-restore','--mount',`type=bind,source=${resolve(passfile)},target=/run/secrets/pgpass,readonly`,'-e','PGCONNECT_TIMEOUT=15','-e','PGPASSFILE=/run/secrets/pgpass','-e',`PGHOST=${url.hostname}`,'-e',`PGPORT=${url.port||5432}`,'-e',`PGUSER=${decodeURIComponent(url.username)}`,'-e',`PGDATABASE=${decodeURIComponent(url.pathname.slice(1))}`,'-e',`PGSSLMODE=${url.searchParams.get('sslmode')??'verify-full'}`];
 if(url.searchParams.has('sslrootcert'))args.push('--mount',`type=bind,source=${resolve(config,'database-ca.crt')},target=/run/secrets/ca.crt,readonly`,'-e','PGSSLROOTCERT=/run/secrets/ca.crt');
 return {args:[...args,CLIENT_IMAGE],passfile};
}
async function verify(config,directory){
 const manifest=JSON.parse(await readFile(join(directory,'manifest.json')));const {pool}=await target(config);
 try{for(const schema of schemas){const actual=await targetSnapshot(pool,schema);if(JSON.stringify(actual)!==JSON.stringify(manifest.schemas[schema]))throw new Error(`Data verification failed for ${schema}; keep local services stopped and do not cut over`);}
  console.log(JSON.stringify({verification:'passed',schemas,checks:['all table row counts','all table row digests','all sequence values']}));
 }finally{await pool.end();}
}
async function restore(config,directory){
 await preflight(config);const manifest=JSON.parse(await readFile(join(directory,'manifest.json')));const {pool}=await target(config);const {args,passfile}=await clientArgs(config,directory);
 try{const pending=[];for(const schema of schemas){const actual=await targetSnapshot(pool,schema);
   if(actual.tables.length||actual.sequences.length){if(JSON.stringify(actual)===JSON.stringify(manifest.schemas[schema]))continue;throw new Error(`Target ${schema} schema is not empty and differs from backup; nothing was overwritten`);}
   if((await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rowCount)throw new Error(`Target ${schema} schema already exists; use an unused target namespace`);
   await readFile(join(directory,`${schema}.supabase.dump`));pending.push(schema);
  }
  for(const schema of pending){
   await run([...args,'pg_restore','--no-owner','--no-privileges','--exit-on-error','--single-transaction','--dbname',decodeURIComponent((await targetConfig(config)).pathname.slice(1))],{input:join(directory,`${schema}.supabase.dump`)});
  }
 }finally{await pool.end();await rm(passfile,{force:true});}
 await verify(config,directory);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),command=args[0],get=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
 const config=resolve(get('--config')??'.local/supabase'),directory=resolve(get('--backup')??'.local/supabase/backup');
 try{if(command==='preflight')await preflight(config);else if(command==='backup')await backup(get('--project'),directory);else if(command==='stage')await stage(directory);else if(command==='restore')await restore(config,directory);else if(command==='verify')await verify(config,directory);else throw new Error('Usage: migrate.mjs preflight|backup|stage|restore|verify [--config directory] [--backup directory] [--project exact-local-project]');}
 catch(error){const safe=error instanceof Error&&/^(Use |This migration|Session advisory|Specify |Stop only|Private staging|Data verification|Target |Usage:|Prepare |Database command)/.test(error.message);console.error(safe?error.message:'Database operation failed; credentials and server diagnostics were not printed. Local source data is unchanged.');process.exitCode=1;}
}
