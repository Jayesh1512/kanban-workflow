import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'dotenv';
// Deployment CLIs are native ESM JavaScript, deliberately outside the app build.
// @ts-expect-error Deployment script has no TypeScript declaration.
import { databaseConfiguration, configure } from '../../deploy/supabase/configure.mjs';
import { loadRuntimeConfig } from '../../src/platform/config.js';
import { PgDatabase } from '../../src/platform/database.js';
const directories:string[]=[];afterEach(async()=>{for(const d of directories.splice(0))await rm(d,{recursive:true,force:true});});
const base={SUPABASE_DATABASE_URL:'postgresql://postgres.synthetic@aws-0-example.pooler.supabase.com:5432/postgres',SUPABASE_DATABASE_PASSWORD:'synthetic%/=@:$ \'"ü'};
it('produces separate schemas with exact password roundtrip, bounded upstream pool, and verified TLS',()=>{
 const env=parse(databaseConfiguration(base));const u=new URL(env['DATABASE_URL']!);
 expect(decodeURIComponent(u.password)).toBe(base.SUPABASE_DATABASE_PASSWORD);expect(u.searchParams.get('schema')).toBe('antseed');expect(u.searchParams.get('options')).toBeNull();expect(u.searchParams.get('sslmode')).toBe('verify-full');
 expect(env['VIKUNJA_DATABASE_SCHEMA']).toBe('vikunja');expect(Buffer.from(env['VIKUNJA_DATABASE_PASSWORD_B64']!,'base64').toString()).toBe(base.SUPABASE_DATABASE_PASSWORD);expect(env['VIKUNJA_DATABASE_MAXOPENCONNECTIONS']).toBe('8');
 expect(u.searchParams.get('pool_max')).toBe('6');expect(u.searchParams.get('connect_timeout_ms')).toBe('10000');
 expect(env['VIKUNJA_DATABASE_DATABASE']).toBe('postgres');
 expect(new URL(env['SUPABASE_DATABASE_URL']!).searchParams.has('schema')).toBe(false);
});
it('honors explicitly chosen encrypted libpq require mode and a supplied CA without disabling encryption',()=>{
 const env=parse(databaseConfiguration({...base,SUPABASE_DATABASE_URL:base.SUPABASE_DATABASE_URL+'?sslmode=require&host=not-the-configured-host&options=wrong'},{ca:true}));
 const u=new URL(env['DATABASE_URL']!);expect(u.searchParams.get('uselibpqcompat')).toBe('true');expect(u.searchParams.get('host')).toBeNull();expect(u.searchParams.get('sslrootcert')).toBe('/run/antseed/database-ca.crt');expect(env['VIKUNJA_DATABASE_SSLROOTCERT']).toBe('/run/antseed/database-ca.crt');
});
it.each(['postgresql://u:p@aws-0-x.pooler.supabase.com:6543/postgres','postgresql://u:p@db.x.supabase.co:6543/postgres','postgresql://u:p@db.x.supabase.co:5432/postgres?sslmode=disable','https://example.invalid','postgresql://u:[YOUR-PASSWORD]@db.x.supabase.co:5432/postgres'])('rejects unusable or incomplete configuration without echoing credentials: %s',url=>{
 expect(()=>databaseConfiguration({SUPABASE_DATABASE_URL:url})).toThrow();
});
it('refuses known Supabase transaction endpoints even when constructed outside runtime loading',()=>{
 expect(()=>new PgDatabase('postgresql://u:private@aws-0-x.pooler.supabase.com:6543/postgres')).toThrow('session-pooler');
});
it('uses bounded application pool settings without forwarding private adapter parameters to PostgreSQL',async()=>{
 const db=new PgDatabase('postgresql://u:synthetic@localhost:5432/test?pool_max=6&connect_timeout_ms=10000');
 expect(db.pool.options.max).toBe(6);expect(db.pool.options.connectionTimeoutMillis).toBe(10_000);
 const endpoint=new URL(db.pool.options.connectionString!);expect(endpoint.searchParams.has('pool_max')).toBe(false);expect(endpoint.searchParams.has('connect_timeout_ms')).toBe(false);
 await db.close();
 expect(()=>new PgDatabase('postgresql://u:synthetic@localhost/test?pool_max=0')).toThrow('pool_max');
 expect(()=>new PgDatabase('postgresql://u:synthetic@localhost/test?connect_timeout_ms=60001')).toThrow('connect_timeout_ms');
});
it('writes private credentials and CA files and gives explicit database config precedence over the generated local URL',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'antseed-supabase-config-'));directories.push(dir);const input=join(dir,'credentials.env'),ca=join(dir,'root.pem');
 await writeFile(input,`SUPABASE_DATABASE_URL=${base.SUPABASE_DATABASE_URL}\nSUPABASE_DATABASE_PASSWORD=synthetic-secret\n`);await writeFile(ca,'synthetic-ca');
 await configure({input,output:join(dir,'out'),caFile:ca});const output=join(dir,'out','database.env');expect((await stat(output)).mode&0o777).toBe(0o600);expect((await stat(join(dir,'out'))).mode&0o777).toBe(0o700);expect(await readFile(join(dir,'out','database-ca.crt'),'utf8')).toBe('synthetic-ca');
 const runtime=join(dir,'runtime.env');await writeFile(runtime,'DATABASE_URL=postgresql://local:private@localhost:5432/local\nVIKUNJA_PASSWORD=preserved-service-login\n');
 const cfg=await loadRuntimeConfig({AI_ENV_PATH:'/missing',RUNTIME_ENV_PATH:runtime,DATABASE_ENV_PATH:output});expect(new URL(cfg.databaseUrl).searchParams.get('schema')).toBe('antseed');expect(cfg.vikunja.password).toBe('preserved-service-login');expect(cfg.vikunja.timeoutMs).toBe(45_000);
 expect((await loadRuntimeConfig({AI_ENV_PATH:'/missing',DATABASE_ENV_PATH:output,VIKUNJA_TIMEOUT_MS:'60000'})).vikunja.timeoutMs).toBe(60_000);
 expect((await loadRuntimeConfig({AI_ENV_PATH:'/missing'})).vikunja.timeoutMs).toBe(10_000);
 await expect(loadRuntimeConfig({AI_ENV_PATH:'/missing',VIKUNJA_TIMEOUT_MS:'120001'})).rejects.toThrow('VIKUNJA_TIMEOUT_MS');
 const direct=await loadRuntimeConfig({AI_ENV_PATH:'/missing',DATABASE_ENV_PATH:output,DATABASE_URL:'postgresql://override:p@localhost:5432/override'});expect(new URL(direct.databaseUrl).hostname).toBe('localhost');
});
it('never silently falls back to a local database when an explicit external file is missing or empty',async()=>{
 await expect(loadRuntimeConfig({AI_ENV_PATH:'/missing',DATABASE_ENV_PATH:'/missing/database.env'})).rejects.toThrow('database configuration');
 const dir=await mkdtemp(join(tmpdir(),'antseed-supabase-empty-'));directories.push(dir);const path=join(dir,'empty.env');await writeFile(path,'# no URL\n');await expect(loadRuntimeConfig({AI_ENV_PATH:'/missing',DATABASE_ENV_PATH:path})).rejects.toThrow('DATABASE_URL');
});
