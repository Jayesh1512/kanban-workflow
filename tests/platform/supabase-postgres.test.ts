import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { parse } from 'dotenv';
import { PgDatabase, migrate } from '../../src/platform/database.js';
import { createMigrationGate } from '../../src/platform/migration-gate.js';
const directory=process.env['SUPABASE_NATIVE_CONFIG_DIR'];
describe.skipIf(!directory)('isolated TLS PostgreSQL Supabase-compatible deployment (not a real Supabase account)',()=>{
 let database:PgDatabase, url:URL;
 beforeAll(async()=>{
  const project=process.env['SUPABASE_NATIVE_PROJECT'];if(!/^antseed-supabase-qa-[a-z0-9-]+$/.test(project??''))throw new Error('Require the explicitly isolated native QA project');
  const values=parse(await readFile(resolve(directory!,'database.env')));url=new URL(values['DATABASE_URL']!);url.searchParams.set('sslrootcert',resolve(directory!,'database-ca.crt'));database=new PgDatabase(url.toString());
 });
 afterAll(async()=>{await database?.close();});
 it('selects the private backend schema on every checked-out session with TLS and exact migration checksums',async()=>{
  await migrate(database);const gate=await createMigrationGate(database);expect(await gate()).toBe('ready');
  await database.withSessionLock(`native-schema:${randomUUID()}`,async sql=>{
   expect((await sql.query('SELECT current_schema() AS schema')).rows[0]?.['schema']).toBe('antseed');
   expect((await sql.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0]?.['ssl']).toBe(true);
  });
 });
 it('retains session advisory lock ownership across SQL transactions and excludes a different connection',async()=>{
  const other=new PgDatabase(url.toString()),key=`native-tls-lock:${randomUUID()}`;
  try{await database.withSessionLock(key,async()=>{
   await database.transaction(tx=>tx.query('SELECT 1'));await database.query('SELECT 1');
   const result=await other.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[key]);expect(result.rows[0]?.['acquired']).toBe(false);
  });}finally{await other.close();}
 });
 it('refuses a missing configured schema instead of falling back to public tables',async()=>{
  const missing=new URL(url);missing.searchParams.set('schema',`missing_${randomUUID().replaceAll('-','')}`);const db=new PgDatabase(missing.toString());
  try{await expect(db.query('SELECT 1')).rejects.toThrow('schema is unavailable');}finally{await db.close();}
 });
 it('preserves unrelated public tables and literal public.* business text after native schema remapping',async()=>{
  const client=new pg.Client({connectionString:url.toString()});await client.connect();
  try{expect((await client.query('SELECT count(*)::int AS n FROM public.supabase_existing')).rows[0].n).toBe(1);
   expect((await client.query('SELECT text FROM antseed.messages WHERE chat_id=-444 AND id=1')).rows[0].text).toBe('Literal public.marker text, unchanged through schema rename.');
   expect((await client.query('SELECT count(*)::int AS n FROM vikunja.users')).rows[0].n).toBe(1);
  }finally{await client.end();}
 });
 it('serves the original account and board while its own source PostgreSQL container is stopped',async()=>{
  const project=process.env['SUPABASE_NATIVE_PROJECT']!;
  const states=execFileSync('docker',['compose','-p',project,'-f','compose.yaml','ps','--all','--format','json','postgres'],{encoding:'utf8'}).trim();expect(JSON.parse(states).State).toBe('exited');
  const response=await fetch(process.env['SUPABASE_NATIVE_BACKEND_URL']!+'/api/status');const status=await response.json() as {accountBound:boolean;components:Record<string,{state:string}>};
  expect(response.status).toBe(200);expect(status.accountBound).toBe(true);expect(status.components['database']?.state).toBe('ready');expect(status.components['vikunja']?.state).toBe('ready');
 });
});
