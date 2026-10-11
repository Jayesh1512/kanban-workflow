import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../store/index.ts';
import { assertNoHandles, exclusiveFile } from './durability-support.ts';
import { message } from './test-support.ts';

function worker(mode: string, path: string) {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./crash-worker.ts', import.meta.url)), mode, path],
    { encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assertNoHandles(path);
  return JSON.parse(result.stdout) as { phase: string; pid: number };
}

test('H1 REQ1 fresh-process page1 crash BEFORE failure resumes BELOW source and links exactly once', (t) => {
  const { directory, path } = exclusiveFile();
  try {
    const first = worker('crash', path); // spawnSync has waited for predecessor exit before any successor opens.
    assert.equal(first.phase, 'committed-before-failure');
    t.diagnostic(JSON.stringify({ db: path, predecessor: first.pid, exited: true, exclusive: true }));
    const second = worker('resume', path);
    assert.equal(second.phase, 'resumed-exactly-once');
    assert.notEqual(second.pid, first.pid);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('H1 REQ3 fresh-process page1 crash retains original exact bound/request/opaque resume BEFORE failure transaction', (t) => {
  const { directory, path } = exclusiveFile();
  try {
    const first = worker('crash', path);
    t.diagnostic(JSON.stringify({ db: path, predecessor: first.pid, exited: true, exclusive: true }));
    const db = openDb(path);
    try {
      const r = db.get<{
        sync_origin_state: string;
        sync_gap_from: string;
        sync_after: string;
        sync_since: null;
        sync_limit: null;
        sync_resume: string;
        sync_newest: string;
        sync_failed_since: null;
      }>('SELECT * FROM account_chat');
      assert.equal(r?.sync_origin_state, 'captured');
      assert.equal(r?.sync_gap_from, message(1).sentAt);
      assert.equal(r?.sync_after, 'opaque-original-after');
      assert.equal(r?.sync_since, null);
      assert.equal(r?.sync_limit, null);
      assert.equal(r?.sync_resume, 'opaque-below-source');
      assert.equal(r?.sync_newest, 'opaque-head');
      assert.equal(r?.sync_failed_since, null);
      assert.equal(db.get<{ n: number }>('SELECT count(*) AS n FROM chat_gap')?.n, 0);
    } finally {
      db.close();
    }
    worker('resume', path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
