import { readFile, mkdir, chmod, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { parse } from 'dotenv';
import pg from 'pg';

const args=process.argv.slice(2),configDir=resolve(args[args.indexOf('--config')+1]&&args.includes('--config')?args[args.indexOf('--config')+1]:'.local/supabase');
const backup=args.includes('--backup')?resolve(args[args.indexOf('--backup')+1]):null;
const config=parse(await readFile(`${configDir}/database.env`)),access=parse(await readFile(`${configDir}/access.env`));
const url=new URL(config.DATABASE_URL);
const rootcert=url.searchParams.get('sslrootcert');
for(const key of ['schema','pool_max','connect_timeout_ms','query_timeout_ms','sslmode','sslrootcert'])url.searchParams.delete(key);
const client=new pg.Client({connectionString:url.toString(),ssl:{rejectUnauthorized:true,...(rootcert?{ca:await readFile(`${configDir}/database-ca.crt`,'utf8')}:{})},connectionTimeoutMillis:10000,query_timeout:30000});
async function run(command,parameters,env){
  await new Promise((resolve,reject)=>{
    // Upstream stderr can contain endpoint details; keep it private in the backup.
    let stderr='';const child=spawn(command,parameters,{env:{...process.env,...env},stdio:['ignore','ignore','pipe']});
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.on('error',reject);child.on('exit',async code=>{if(code===0)resolve();else{if(backup)await writeFile(`${backup}/backup-error.log`,stderr,{mode:0o600});reject(Error('Backup command failed; inspect the private backup log'));}});
  });
}
try{
  await client.connect();
  const inventory=(await client.query(`SELECT
    (SELECT count(*) FROM antseed.tickets) AS work_tickets,
    (SELECT count(*) FROM antseed.outreach_relationships WHERE retained) AS crm_relationships,
    (SELECT count(*) FROM vikunja.tasks) AS vikunja_tasks,
    (SELECT count(*) FROM vikunja.task_comments) AS task_comments,
    (SELECT count(*) FROM vikunja.task_attachments) AS task_attachments,
    (SELECT count(*) FROM antseed.outreach_remote_requests WHERE state IN ('dispatched','remote_unresolved')) AS unresolved_requests,
    (SELECT count(*) FROM antseed.mutations WHERE state IN ('prepared','remote_unknown','remote_confirmed')) AS active_mutations`)).rows[0];
  if(inventory.unresolved_requests!=='0'||inventory.active_mutations!=='0')throw Error('Resolve in-flight Vikunja operations before cutover');
  const auth=await fetch(`${access.SUPABASE_URL}/auth/v1/settings`,{headers:{apikey:access.SUPABASE_PUBLISHABLE_KEY},signal:AbortSignal.timeout(15000)});
  if(!auth.ok)throw Error(`Supabase Auth settings failed with HTTP ${auth.status}`);
  const settings=await auth.json();
  if(!settings.external?.email)throw Error('Enable email/password in Supabase Auth before cutover');
  if(settings.mailer_autoconfirm!==false)throw Error('Enable email confirmation in Supabase before configuring administrator access');
  console.log(JSON.stringify({inventory,auth:'email provider available',adminConfigured:!!access.WORKSPACE_ADMIN_EMAIL}));
  if(backup){
    await mkdir(backup,{recursive:false,mode:0o700});
    const image='postgres:17.11-bookworm@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826';
    const env={PGHOST:url.hostname,PGPORT:String(url.port||5432),PGDATABASE:url.pathname.slice(1),PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),PGSSLMODE:'verify-full',...(rootcert?{PGSSLROOTCERT:'/config/database-ca.crt'}:{})};
    const parameters=['run','--rm',...Object.keys(env).flatMap(key=>['-e',key]),'--mount',`type=bind,source=${configDir},target=/config,readonly`,'--mount',`type=bind,source=${backup},target=/backup`,image];
    await run('docker',[...parameters,'pg_dump','--schema=antseed','--schema=vikunja','--format=custom','--file=/backup/application.dump'],env);
    await chmod(`${backup}/application.dump`,0o600);
    await run('docker',[...parameters,'pg_restore','--list','/backup/application.dump'],env);
    await writeFile(`${backup}/manifest.json`,JSON.stringify({createdAt:new Date().toISOString(),schemas:['antseed','vikunja'],inventory,format:'PostgreSQL custom dump',note:'Inventory is a preflight observation. pg_dump provides its own consistent snapshot.'},null,2),{mode:0o600});
    console.log('Consistent backup saved and archive catalog verified.');
  }
}catch(error){console.error(error instanceof Error&& !('code'in error)?error.message:'Database preflight failed; no credentials were printed.');process.exitCode=1;}
finally{await client.end().catch(()=>{});}
