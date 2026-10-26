import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

export function databaseConfiguration(values, { ca = false } = {}) {
  let url;
  try { url = new URL(values.SUPABASE_DATABASE_URL); }
  catch { throw new Error('Provide a valid PostgreSQL connection string in SUPABASE_DATABASE_URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.pathname.slice(1)) throw new Error('Incomplete PostgreSQL connection string');
  if (url.port && url.port !== '5432') throw new Error('Use the direct or Session pooler connection on port 5432, not transaction pooling');
  if (values.SUPABASE_DATABASE_PASSWORD) url.password = encodeURIComponent(values.SUPABASE_DATABASE_PASSWORD);
  let password, user, database;
  try { password=decodeURIComponent(url.password); user=decodeURIComponent(url.username); database=decodeURIComponent(url.pathname.slice(1)); }
  catch { throw new Error('Invalid percent encoding in PostgreSQL credentials'); }
  if (!password || /\[YOUR[-_ ]PASSWORD\]|CHANGE_ME/i.test(password)) throw new Error('Set the actual database password in the private credentials file');
  if ([password,user,database,url.hostname].some(v=>/[\r\n\0]/.test(v))) throw new Error('Database connection fields cannot contain newlines or NUL');
  const sslmode = url.searchParams.get('sslmode') ?? 'verify-full';
  if (!['require','verify-full'].includes(sslmode)) throw new Error('Supabase requires encrypted PostgreSQL connections');
  // Only carry supported connection settings; do not retain an accidental
  // transaction-pooler/search_path/URL override from a copied dashboard URL.
  url.search=''; url.port='5432'; url.searchParams.set('sslmode',sslmode);
  if(sslmode==='require')url.searchParams.set('uselibpqcompat','true');
  if(ca)url.searchParams.set('sslrootcert','/run/antseed/database-ca.crt');
  const backend=new URL(url); backend.searchParams.set('schema','antseed');
  // Both apps share a session-pooler budget. Reserve headroom instead of
  // allowing independent default pools to exhaust it during concurrent startup.
  backend.searchParams.set('pool_max','6');backend.searchParams.set('connect_timeout_ms','10000');
  return [
    `SUPABASE_DATABASE_URL=${url}`, `DATABASE_URL=${backend}`,
    `VIKUNJA_DATABASE_HOST=${url.hostname}:5432`, `VIKUNJA_DATABASE_USER=${user}`,
    `VIKUNJA_DATABASE_DATABASE=${database}`, 'VIKUNJA_DATABASE_SCHEMA=vikunja',
    `VIKUNJA_DATABASE_PASSWORD_B64=${Buffer.from(password).toString('base64')}`,
    `VIKUNJA_DATABASE_SSLMODE=${sslmode}`, ...(ca?['VIKUNJA_DATABASE_SSLROOTCERT=/run/antseed/database-ca.crt']:[]),
    // Five connections can all be occupied by nested native task reads, leaving
    // even the database-backed health endpoint waiting for a free connection.
    'VIKUNJA_DATABASE_MAXOPENCONNECTIONS=8', 'VIKUNJA_DATABASE_MAXIDLECONNECTIONS=2','',
  ].join('\n');
}
export async function privateWrite(path,content) {
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW,0o600);
  try { await file.chmod(0o600); await file.writeFile(content); } finally { await file.close(); }
}
export async function configure({input,output,caFile}) {
  const values=parse(await readFile(input));
  const content=databaseConfiguration(values,{ca:Boolean(caFile)});
  await mkdir(output,{recursive:true,mode:0o700}); await chmod(output,0o700);
  if(caFile){await copyFile(caFile,join(output,'database-ca.crt'));await chmod(join(output,'database-ca.crt'),0o600);}
  await privateWrite(join(output,'database.env'),content);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2), value=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
  try {
    const input=value('--credentials-file'); if(!input)throw new Error('Usage: node deploy/supabase/configure.mjs --credentials-file <private.env> [--output .local/supabase] [--ca-file <certificate.pem>]');
    await configure({input,output:value('--output')??'.local/supabase',caFile:value('--ca-file')});
    console.log('Private database.env prepared. Credentials were not printed. No database connection or service change made.');
  } catch(error) { console.error(error instanceof Error?error.message:'Database configuration failed');process.exitCode=1; }
}
