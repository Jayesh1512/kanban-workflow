// Run after `npm run build`: node tests/qa-m0-runtime.mjs
// Actual compiled process/native host checks; no provider/Telegram connection.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const entrypoint = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const require = createRequire(import.meta.url);

async function healthAndShutdown(signal) {
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  // Pass no inherited AI/Telegram keys/config into the foundation process.
  const child = spawn(process.execPath, [entrypoint], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '', HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => { output = (output + data).slice(-16_384); });
  child.stderr.on('data', (data) => { output = (output + data).slice(-16_384); });
  const exited = once(child, 'exit');
  try {
    let live;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      try { live = await fetch(`http://127.0.0.1:${port}/health/live`, { signal: AbortSignal.timeout(500) }); break; }
      catch { await delay(50); }
    }
    assert(live, `Compiled entrypoint did not listen: ${output}`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: 'ok', service: 'antseed-kanban', milestone: 'M0' });
    const ready = await fetch(`http://127.0.0.1:${port}/health/ready`, { signal: AbortSignal.timeout(1_000) });
    assert.equal(ready.status, 503);
    const body = await ready.json();
    assert.equal(body.status, 'not_ready');
    assert.deepEqual(body.modules, []);
    assert.match(body.detail, /not configured.*M0/);
    assert(child.kill(signal));
    const timeout = AbortSignal.timeout(5_000);
    const [code, terminationSignal] = await Promise.race([
      exited,
      new Promise((_, reject) => timeout.addEventListener('abort', () => reject(new Error('Shutdown exceeded 5 seconds')), { once: true })),
    ]);
    assert.equal(code, 0);
    assert.equal(terminationSignal, null);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health/live`, { signal: AbortSignal.timeout(500) }));
    console.log(`PASS compiled loopback live=200 ready=503 M0-unconfigured ${signal}=exit0 listener-closed`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }
}

const directory = await mkdtemp(join(tmpdir(), 'antseed-qa-m0-native-'));
try {
  const NativeDatabase = require('better-sqlite3');
  const path = join(directory, 'synthetic.sqlite');
  const writer = new NativeDatabase(path);
  try {
    writer.exec('CREATE TABLE qa_marker(value TEXT NOT NULL)');
    writer.prepare('INSERT INTO qa_marker(value) VALUES(?)').run('synthetic-native-marker');
    assert.deepEqual(writer.prepare('SELECT value FROM qa_marker').get(), { value: 'synthetic-native-marker' });
  } finally { writer.close(); }
  const reader = new NativeDatabase(path, { readonly: true });
  try { assert.equal(reader.prepare('SELECT value FROM qa_marker').get().value, 'synthetic-native-marker'); }
  finally { reader.close(); }
  console.log(`PASS native better-sqlite3 file write/read/close/reopen platform=${process.platform}/${process.arch} node=${process.version}`);
  await healthAndShutdown('SIGTERM');
  await healthAndShutdown('SIGINT');
} finally {
  await rm(directory, { recursive: true, force: true });
}
