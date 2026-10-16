// Explicitly scoped destructive lifecycle test: only the supplied test project is restarted/downed.
// Never removes volumes. Requires an already-built isolated stack and synthetic test data.
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const project = process.env.PLATFORM_TEST_PROJECT;
if (!project || !project.startsWith('antseed-')) throw new Error('Set PLATFORM_TEST_PROJECT to an isolated antseed-* test project');
const base = ['compose', '-p', project, '-f', 'compose.yaml'];
if (process.env.PLATFORM_TEST_PORTS_FILE) base.push('-f', process.env.PLATFORM_TEST_PORTS_FILE);
const run = (args) => {
  try { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000 }); }
  catch { throw new Error(`Scoped Docker operation failed (${args[0]}); inspect ${project} logs privately`); }
};
const compose = (...args) => run([...base, ...args]);
const port = process.env.BACKEND_PORT ?? '18380';
async function waitFor(predicate, label) {
  for (let i = 0; i < 100; i++) {
    try {
      const s = await fetch(`http://127.0.0.1:${port}/api/status`).then((r) => r.json());
      if (predicate(s)) return s;
    } catch { /* bounded reconnect */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
const ready = (s) => s.components.database.state === 'ready' && s.components.vikunja.state === 'ready';
const execNode = (script) => compose('exec', '-T', 'backend', 'node', '--input-type=module', '-e', script);
const snapshot = () => JSON.parse(execNode(`
  import pg from 'pg';import {loadRuntimeConfig} from './dist/platform/config.js';
  const c=await loadRuntimeConfig(),db=new pg.Client(c.databaseUrl);await db.connect();
  const result={};for(const [key,query]of Object.entries({board:'SELECT project_id,view_id FROM board_bindings',buckets:'SELECT lane,bucket_id FROM board_buckets ORDER BY lane',labels:'SELECT workstream,label_id FROM board_labels ORDER BY workstream',tickets:'SELECT id,vikunja_task_id FROM tickets ORDER BY id',migrations:'SELECT version,checksum FROM schema_migrations ORDER BY version'}))result[key]=(await db.query(query)).rows;
  console.log(JSON.stringify(result));await db.end();
`));
await waitFor(ready, 'initial board readiness');
const before = snapshot();
// Read only into memory for equality, never output credential values or hashes.
const credentials = compose('exec', '-T', 'backend', 'cat', '/run/antseed/runtime.env');
execNode(`import Database from 'better-sqlite3';import {TelegramClient} from '@mtcute/node';
  const db=new Database('/data/telegram/m1-native.sqlite');db.exec("CREATE TABLE IF NOT EXISTS marker(id integer PRIMARY KEY,value text)");db.prepare('INSERT OR IGNORE INTO marker VALUES(1,?)').run('m1-persisted');db.close();
  const tg=new TelegramClient({apiId:1,apiHash:'offline-only',storage:'/data/telegram/m1-offline.session'});await tg.prepare();await tg.destroy();`);
compose('exec', '-T', 'vikunja', 'sh', '-c', 'printf m1-file-marker > /app/vikunja/files/m1-persistence-probe');
const container = compose('ps', '-q', 'backend').trim();
const inspect = JSON.parse(run(['inspect', container]))[0];
assert.equal(inspect.Mounts.find((m) => m.Destination === '/run/config/ai.env').RW, false);
const volume = inspect.Mounts.find((m) => m.Destination === '/data/telegram').Name;
run(['run', '--rm', '--network', 'none', '--user', '1000:1000', '-v', `${volume}:/data/telegram`, inspect.Image, 'node', '--input-type=module', '-e', `
  import assert from 'node:assert/strict';import Database from 'better-sqlite3';import {TelegramClient} from '@mtcute/node';
  const db=new Database('/data/telegram/m1-native.sqlite');assert.equal(db.prepare('SELECT value FROM marker WHERE id=1').get().value,'m1-persisted');db.close();const tg=new TelegramClient({apiId:1,apiHash:'offline-only',storage:'/data/telegram/m1-offline.session'});await tg.prepare();await tg.destroy();`]);
console.log('PASS target-native SQLite/session directory reopen with network disabled; AI bind is read-only');
compose('restart', 'postgres', 'vikunja', 'backend');
await waitFor(ready, 'restart recovery');
assert.deepEqual(snapshot(), before);
assert.equal(compose('exec', '-T', 'backend', 'cat', '/run/antseed/runtime.env'), credentials);
console.log('PASS service restart preserves IDs, checksums, data and generated credentials');
compose('down');
compose('up', '-d');
await waitFor(ready, 'persistent recreate');
assert.deepEqual(snapshot(), before);
assert.equal(compose('exec', '-T', 'backend', 'cat', '/run/antseed/runtime.env'), credentials);
assert.equal(compose('exec', '-T', 'vikunja', 'cat', '/app/vikunja/files/m1-persistence-probe'), 'm1-file-marker');
assert.equal(compose('exec', '-T', 'postgres', 'psql', '-U', 'antseed', '-d', 'vikunja', '-At', '-c', "SELECT count(*) FROM users WHERE username='antseed'").trim(), '1');
console.log('PASS down/up retains four named volumes, one service user and unchanged board/task identities');
compose('stop', 'vikunja');
await waitFor((s) => s.components.database.state === 'ready' && s.components.vikunja.state !== 'ready', 'Vikunja outage reporting');
assert.equal((await fetch(`http://127.0.0.1:${port}/health/live`)).status, 200);
compose('start', 'vikunja');
await waitFor(ready, 'Vikunja recovery');
assert.deepEqual(snapshot(), before);
console.log('PASS upstream outage/recovery is visible while local onboarding/liveness remains reachable');
console.log(`Resources retained for review: project ${project}; no volumes removed`);
