// Real isolated M1 black-box lifecycle. No Telegram/provider requests or volume deletion.
// QA_M1_MANIFEST must name the local isolation manifest described in QA_M1_REPORT.md.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { parse } from 'dotenv';

const manifest = JSON.parse(await readFile(process.env.QA_M1_MANIFEST ?? '', 'utf8'));
const { project, root, compose_args: base, environment_overrides: overrides, ports } = manifest;
assert.match(project, /^antseed-qa-m1-[a-z0-9-]+$/);
assert.equal(root, process.cwd());
assert.deepEqual(base.slice(0, 6), ['docker', 'compose', '--project-name', project, '--project-directory', root]);
const env = { ...process.env, ...overrides };
const run = (args, options = {}) => {
  try { return execFileSync('docker', args, { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...options }); }
  catch { throw new Error(`QA scoped Docker operation failed; inspect ${project} privately`); }
};
const compose = (...args) => run([...base.slice(1), ...args]);
const execNode = (source) => compose('exec', '-T', 'backend', 'node', '--input-type=module', '-e', source);
const psql = (sql) => compose('exec', '-T', 'postgres', 'psql', '-U', 'antseed', '-d', 'antseed', '-At', '-c', sql).trim();
async function request(path) { return fetch(`http://127.0.0.1:${ports.backend}${path}`, { signal: AbortSignal.timeout(5_000) }); }
async function waitFor(predicate, label) {
  for (let n = 0; n < 60; n++) {
    try { const r = await request('/api/status'); const s = await r.json(); if (r.ok && predicate(s)) return s; } catch { /* bounded recovery */ }
    await delay(500);
  }
  throw new Error(`QA timeout: ${label}`);
}
const ready = (s) => s.components.database.state === 'ready' && s.components.vikunja.state === 'ready';
async function responsive() {
  for (const path of ['/', '/health/live']) {
    const started = Date.now(); const r = await request(path);
    assert.equal(r.status, 200); await r.text();
    assert(Date.now() - started < 2_000, `Local ${path} blocked by upstream outage`);
  }
}
const container = compose('ps', '-q', 'backend').trim();
const inspect = JSON.parse(run(['inspect', container]))[0];
assert.equal(inspect.Config.Labels['com.docker.compose.project'], project);
assert.deepEqual(inspect.Config.Cmd, ['node', 'dist/main.js']);
assert.deepEqual(JSON.parse(run(['image', 'inspect', inspect.Image]))[0].Config.Cmd, ['node', 'dist/main.js']);
for (const suffix of ['postgres_data', 'runtime_state', 'vikunja_files', 'telegram_sessions']) {
  const v = JSON.parse(run(['volume', 'inspect', `${project}_${suffix}`]))[0];
  assert.equal(v.Labels['com.docker.compose.project'], project);
}
const runtime = compose('exec', '-T', 'backend', 'cat', '/run/antseed/runtime.env');
const credentials = parse(runtime);
const ai = parse(compose('exec', '-T', 'backend', 'cat', '/run/config/ai.env'));
const secrets = [...Object.entries(credentials).filter(([k]) => /PASSWORD|SECRET/.test(k)).map(([, v]) => v), ...Object.entries(ai).filter(([k, v]) => /_KEY$/.test(k) && v).map(([, v]) => v)];
assert.equal(inspect.Mounts.find((m) => m.Destination === '/run/config/ai.env').RW, false);
const readonly = JSON.parse(execNode(`import {open,stat} from 'node:fs/promises';let denied=false;try{const f=await open('/run/config/ai.env','a');await f.close();}catch(e){denied=e.code==='EROFS';}const s=await stat('/run/antseed/runtime.env');console.log(JSON.stringify({denied,uid:process.getuid(),credentialUid:s.uid,mode:s.mode&511}));`));
assert.deepEqual(readonly, { denied: true, uid: 1000, credentialUid: 1000, mode: 256 });
await waitFor(ready, 'initial database/board');

async function vapi(path, token) {
  const response = await fetch(`http://127.0.0.1:${ports.vikunja}/api/v2${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 200); return response.json();
}
const login = await fetch(`http://127.0.0.1:${ports.vikunja}/api/v2/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: credentials.VIKUNJA_USERNAME, password: credentials.VIKUNJA_PASSWORD }) });
assert.equal(login.status, 200);
const { token } = await login.json();
secrets.push(token);
async function snapshot() {
  const local = JSON.parse(execNode(`import pg from 'pg';import {loadRuntimeConfig} from './dist/platform/config.js';const c=await loadRuntimeConfig(),db=new pg.Client(c.databaseUrl);await db.connect();const out={};for(const [k,q]of Object.entries({board:'SELECT project_id,view_id FROM board_bindings',buckets:'SELECT lane,bucket_id FROM board_buckets ORDER BY lane',labels:'SELECT workstream,label_id FROM board_labels ORDER BY workstream',tickets:'SELECT id,vikunja_task_id,lane,stage_version FROM tickets ORDER BY id',migrations:'SELECT version,checksum FROM schema_migrations ORDER BY version',namespace:"SELECT value FROM app_settings WHERE key='vikunja_namespace'"}))out[k]=(await db.query(q)).rows;await db.end();console.log(JSON.stringify(out));`));
  const { project_id: p, view_id: v } = local.board[0];
  const view = await vapi(`/projects/${p}/views/${v}`, token);
  const buckets = await vapi(`/projects/${p}/views/${v}/buckets`, token);
  const labels = await vapi('/labels', token);
  const tasks = [];
  for (const ticket of local.tickets) if (ticket.vikunja_task_id) {
    const task = await vapi(`/tasks/${ticket.vikunja_task_id}`, token);
    const grouped = await vapi(`/projects/${p}/views/${v}/buckets/tasks?filter=${encodeURIComponent(`id = ${ticket.vikunja_task_id}`)}`, token);
    const bucket = grouped.items.find((b) => b.tasks?.some((t) => String(t.id) === ticket.vikunja_task_id));
    assert(bucket);
    tasks.push({ id: task.id, bucket: bucket.id, done: task.done, title: task.title, description: task.description, priority: task.priority, due_date: task.due_date, percent_done: task.percent_done, labels: task.labels.map((l) => l.id).sort() });
  }
  return { local, remote: { view: { id: view.id, default_bucket_id: view.default_bucket_id, done_bucket_id: view.done_bucket_id, filter: view.filter }, buckets: buckets.items.map(({ id, title, position }) => ({ id, title, position })), labels: labels.items.map(({ id, title }) => ({ id, title })).sort((a, b) => a.id - b.id), tasks } };
}
const before = await snapshot();
compose('up', '-d'); await waitFor(ready, 'repeat up');
assert.deepEqual(await snapshot(), before);
assert.equal(compose('exec', '-T', 'backend', 'cat', '/run/antseed/runtime.env'), runtime);
console.log('PASS canonical repeat up: actual board/view/task/label semantics and generated credentials unchanged');

compose('stop', 'postgres');
try {
  await waitFor((s) => s.components.database.state === 'unavailable', 'PostgreSQL outage');
  await responsive(); assert.equal((await request('/health/ready')).status, 503);
  console.log('PASS real PostgreSQL outage: database unavailable; setup/live responsive; readiness 503');
} finally { compose('start', 'postgres'); }
await waitFor(ready, 'PostgreSQL recovery');
assert.deepEqual(await snapshot(), before);

const checksum = before.local.migrations[0].checksum;
assert.match(checksum, /^[0-9a-f]{64}$/);
compose('stop', 'backend');
psql("UPDATE schema_migrations SET checksum=repeat('0',64) WHERE version='001_initial.sql'");
compose('start', 'backend');
try {
  const drift = await waitFor((s) => s.components.database.code === 'migration_drift', 'checksum rejection');
  await responsive(); assert.equal((await request('/health/ready')).status, 503);
  await delay(5_500);
  const still = await (await request('/api/status')).json();
  assert.equal(still.components.database.checkedAt, drift.components.database.checkedAt);
  assert.equal(psql('SELECT count(*) FROM schema_migrations'), String(before.local.migrations.length));
  console.log('PASS real checksum drift: honest permanent failure, no repeated retry, setup/live responsive, no extra ledger');
} finally {
  psql(`UPDATE schema_migrations SET checksum='${checksum}' WHERE version='001_initial.sql'`);
  compose('restart', 'backend');
}
await waitFor(ready, 'checksum restore');

compose('stop', 'backend');
psql("DELETE FROM board_buckets WHERE lane='Blocked'; DELETE FROM board_labels WHERE workstream='Buyer'");
compose('start', 'backend'); await waitFor(ready, 'partial bootstrap reconciliation');
assert.deepEqual(await snapshot(), before);
console.log('PASS partial local bootstrap interruption: original remote IDs recovered without duplicates');

compose('down'); compose('up', '-d'); await waitFor(ready, 'persistent recreation');
assert.deepEqual(await snapshot(), before);
assert.equal(compose('exec', '-T', 'backend', 'cat', '/run/antseed/runtime.env'), runtime);
assert.equal(compose('exec', '-T', 'postgres', 'psql', '-U', 'antseed', '-d', 'vikunja', '-At', '-c', "SELECT count(*) FROM users WHERE username='antseed'").trim(), '1');
// Same pre-recreation JWT still works, verifying persisted signing secret through real API.
await vapi(`/projects/${before.local.board[0].project_id}`, token);
console.log('PASS independent persistent down/up: raw remote lanes/done/fields, local identity, credential bundle and signing secret survive');

const publicBodies = await Promise.all(['/', '/api/status', '/health/ready', '/api/telegram/login'].map(async (path) => (await request(path)).text()));
const logs = compose('logs', '--no-color');
const history = run(['history', '--no-trunc', '--format', '{{.CreatedBy}}', inspect.Image]);
for (const secret of secrets) assert(!(publicBodies.join('\n') + logs + history).includes(secret), 'Credential present in public response/log/image history (contents withheld)');

// Scan every exported layer, including gzip-compressed OCI blobs, without writing an image/credential artifact.
const scanner = `import sys,json,subprocess,tarfile,io,gzip
needles=[s.encode() for s in json.load(sys.stdin) if s]
p=subprocess.Popen(['docker','image','save',sys.argv[1]],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
hits=0
with tarfile.open(fileobj=p.stdout,mode='r|*') as archive:
 for member in archive:
  if not member.isfile(): continue
  f=io.BufferedReader(archive.extractfile(member))
  stream=gzip.GzipFile(fileobj=f) if f.peek(2)[:2]==b'\\x1f\\x8b' else f
  tail=b''
  while True:
   chunk=stream.read(1048576)
   if not chunk: break
   data=tail+chunk
   hits+=sum(s in data for s in needles)
   tail=data[-max(map(len,needles)):]
assert p.wait()==0 and hits==0,'Image credential scan failed (contents withheld)'
print('PASS image layers: zero credential matches')`;
for (const image of [inspect.Image, `${project}-vikunja-setup:local`]) {
  try { console.log(execFileSync('python3', ['-c', scanner, image], { input: JSON.stringify(secrets), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000 }).trim()); }
  catch { throw new Error('Image layer credential scan failed; inspect privately, never print matching content'); }
}
console.log('PASS public responses/logs/image history/layers contain no generated passwords, signing secret, JWT or synthetic AI keys');
console.log(`Retained only QA project ${project}; four volumes preserved, no external account/providers used`);
