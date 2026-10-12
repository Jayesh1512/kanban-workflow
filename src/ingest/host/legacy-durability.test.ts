import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test from 'node:test';
import type { Id } from '../../contracts/index.ts';
import { AppError } from '../../contracts/index.ts';
import { record } from '../../log/index.ts';
import { openDb } from '../../store/index.ts';
import { assertNoHandles, durabilityRig } from './durability-support.ts';
import { message } from './test-support.ts';

const unavailable = (e: unknown) =>
  e instanceof AppError && e.code === 'invalid' && e.message === 'Stored sync origin is unavailable';
const snap = (r: Awaited<ReturnType<typeof durabilityRig>>) =>
  ['account_chat', 'chat_gap', 'message', 'message_sighting', 'action_log', 'channel_account'].map((table) =>
    r.db.all(`SELECT * FROM ${table} ORDER BY rowid`),
  );
function seed(r: Awaited<ReturnType<typeof durabilityRig>>, key = 'selected') {
  // Old SQL compatibility stage only: no queue/capture/exact runtime write has occurred on this file.
  const a = r.accounts.get('alice') ?? 0;
  r.db.run(
    "INSERT INTO chat(channel,chat_key,kind,title,created_at) VALUES ('fixture',?,'direct','Synthetic legacy',?)",
    key,
    r.now().toISOString(),
  );
  const c = r.chatId(key);
  r.db.run(
    "INSERT INTO chat_selection(account_id,chat_key,decision,decided_at) VALUES (?,?,'included',?)",
    a,
    key,
    r.now().toISOString(),
  );
  r.db.run("INSERT INTO account_chat(account_id,chat_id,native_chat_id,sync_state) VALUES (?,?,?,'idle')", a, c, key);
  if (key === 'selected') {
    const self = r.db.get<{ self_identity_id: Id }>(
      'SELECT self_identity_id FROM channel_account WHERE id=?',
      a,
    )?.self_identity_id;
    assert.ok(self);
    const id = r.db.run(
      "INSERT INTO message(chat_id,message_key,sender_identity_id,sent_at,text,origin,stored_at) VALUES (?,'legacy-page-message',?,?,'Retained legacy page','history',?)",
      c,
      self,
      message(1).sentAt,
      r.now().toISOString(),
    ).lastInsertRowid;
    r.db.run("INSERT INTO message_sighting(account_id,message_id,native_id) VALUES (?,?,'legacy-native')", a, id);
  }
}

for (const kind of [
  'old-update',
  'old-insert',
  'legacy_unknown',
  'idle-queued',
  'captured-idle',
  'queued-page',
  'none-failed',
] as const)
  test(`pure WHOLE legacy refusal retains page/request/hold on repeat fresh open: ${kind}`, async (t) => {
    // Controlled compatibility SQL finishes BEFORE any new Host consumes this unknown state.
    const r = await durabilityRig({ keys: ['selected', 'good'] });
    t.after(() => r.close());
    seed(r);
    seed(r, 'good');
    await r.host.stopAll();
    const a = r.accounts.get('alice') ?? 0,
      c = r.chatId();
    if (kind === 'old-insert') {
      r.db.run('DELETE FROM account_chat WHERE account_id=? AND chat_id=?', a, c);
      r.db.run(
        "INSERT INTO account_chat(account_id,chat_id,native_chat_id,sync_state,sync_after,sync_resume,sync_newest) VALUES (?,?,?,'syncing','original-after','opaque-page','head')",
        a,
        c,
        'selected',
      );
    } else if (kind === 'old-update')
      r.db.run(
        "UPDATE account_chat SET sync_state='syncing',sync_after='original-after',sync_resume='opaque-page',sync_newest='head' WHERE account_id=? AND chat_id=?",
        a,
        c,
      );
    else if (kind === 'legacy_unknown')
      r.db.run(
        "UPDATE account_chat SET sync_state='syncing',sync_origin_state='legacy_unknown',sync_after='original-after' WHERE account_id=? AND chat_id=?",
        a,
        c,
      );
    else if (kind === 'idle-queued')
      r.db.run("UPDATE account_chat SET sync_origin_state='queued' WHERE account_id=? AND chat_id=?", a, c);
    else if (kind === 'captured-idle')
      r.db.run(
        "UPDATE account_chat SET sync_origin_state='captured',sync_gap_from=? WHERE account_id=? AND chat_id=?",
        message(1).sentAt,
        a,
        c,
      );
    else if (kind === 'queued-page')
      r.db.run(
        "UPDATE account_chat SET sync_state='syncing',sync_origin_state='queued',sync_resume='committed-page' WHERE account_id=? AND chat_id=?",
        a,
        c,
      );
    else
      r.db.run(
        "UPDATE account_chat SET sync_state='failed',sync_failed_since=? WHERE account_id=? AND chat_id=?",
        message(1).sentAt,
        a,
        c,
      );
    const before = snap(r);
    for (let n = 0; n < 2; n++) {
      const fresh = r.build();
      assert.throws(() => fresh.listAccounts(r.ctx()), unavailable);
      await assert.rejects(fresh.startAll(), unavailable);
      assert.deepEqual(snap(r), before);
      assert.throws(
        () => fresh.includeChat(r.ctx(), a, 'good', { agreedWordingVersion: 1, company: null }),
        unavailable,
      );
      await fresh.stopAll();
      // Actual installed migration repeat-open, committed facts preserved; additional read-only handle is closed.
      const other = openDb(r.path);
      assert.equal(other.get<{ n: number }>('SELECT count(*) AS n FROM message')?.n, 1);
      other.close();
    }
  });

for (const status of ['open', 'abandoned', 'closed'] as const)
  test(`old post-migration gap INSERT ${status}: no certification/hiding/reset; lifecycle retains unknown, withdrawal authorized deletion`, async (t) => {
    const r = await durabilityRig({ keys: ['selected', 'good'] });
    t.after(() => r.close());
    seed(r);
    const a = r.accounts.get('alice') ?? 0,
      c = r.chatId(),
      at = r.now().toISOString();
    r.db.run(
      'INSERT INTO chat_gap(account_id,chat_id,from_time,to_time,opened_at,closed_at,abandoned_at) VALUES (?,?,?,?,?,?,?)',
      a,
      c,
      at,
      at,
      at,
      status === 'closed' ? at : null,
      status === 'abandoned' ? at : null,
    );
    assert.equal(
      r.db.get<{ bound_provenance: string }>('SELECT bound_provenance FROM chat_gap')?.bound_provenance,
      'legacy_unknown',
    );
    const before = snap(r);
    if (status === 'closed') {
      assert.deepEqual(r.host.listAccounts(r.ctx())[0]?.gaps, []);
      assert.deepEqual(snap(r), before);
    } else {
      assert.throws(() => r.host.listAccounts(r.ctx()), unavailable);
      assert.throws(() => r.include('alice', 'good'), unavailable);
      assert.deepEqual(snap(r), before);
      await r.host.stopAll();
      const retained = snap(r);
      const fresh = r.build();
      await assert.rejects(fresh.startAll(), unavailable);
      await fresh.stopAll();
      assert.deepEqual(snap(r), retained);
      r.host.excludeChat(r.ctx(), a, 'selected');
      assert.throws(() => r.host.listAccounts(r.ctx()), unavailable);
      assert.equal(r.db.get<{ n: number }>('SELECT count(*) AS n FROM chat_gap')?.n, 1);
      // Reinclude is blocked, so test authorized withdrawal on the other included owner.
      r.include('bob');
      await r.host.settle();
      r.db.tx(() => {
        r.host.markWithdrawn(r.ctx('bob'), r.accounts.get('bob') ?? 0, c);
        record(r.ctx('bob'), { action: 'chat.withdraw', subjectKind: 'chat', subjectId: c });
      });
      assert.equal(r.db.get<{ n: number }>('SELECT count(*) AS n FROM chat_gap')?.n, 0);
    }
  });

test('account removal retains unknown gap and whole-view refusal while clearing every origin/request/pending synchronously', async (t) => {
  const r = await durabilityRig();
  t.after(() => r.close());
  seed(r);
  const a = r.accounts.get('alice') ?? 0,
    c = r.chatId(),
    at = r.now().toISOString();
  r.db.run(
    'INSERT INTO chat_gap(account_id,chat_id,from_time,to_time,opened_at,abandoned_at) VALUES (?,?,?,?,?,?)',
    a,
    c,
    at,
    at,
    at,
    at,
  );
  await r.host.disconnect(r.ctx(), a);
  assert.throws(() => r.host.listAccounts(r.ctx()), unavailable);
  const row = r.db.get<{ sync_origin_state: string; sync_after: null }>(
    'SELECT * FROM account_chat WHERE account_id=?',
    a,
  );
  assert.equal(row?.sync_origin_state, 'none');
  assert.equal(row?.sync_after, null);
  assert.equal(r.db.get<{ n: number }>('SELECT count(*) AS n FROM chat_gap')?.n, 1);
});

test('legacy compatibility file closes fully before corrected consumer, isolated exact activation never shares old writer identity', async () => {
  const r = await durabilityRig();
  seed(r);
  await r.host.stopAll();
  const a = r.accounts.get('alice') ?? 0,
    c = r.chatId();
  const oldPath = r.path;
  r.db.run(
    "UPDATE account_chat SET sync_state='syncing',sync_resume='old-page' WHERE account_id=? AND chat_id=?",
    a,
    c,
  );
  r.db.close();
  assertNoHandles(oldPath);
  const reopened = openDb(oldPath);
  assert.equal(reopened.get<{ sync_origin_state: string }>('SELECT * FROM account_chat')?.sync_origin_state, 'none');
  reopened.close();
  assertNoHandles(oldPath);
  rmSync(r.directory, { recursive: true, force: true });
  const exact = await durabilityRig();
  try {
    assert.notEqual(exact.path, oldPath);
    exact.include();
    await exact.host.settle();
    assert.equal(exact.db.get<{ bound_provenance: string }>('SELECT bound_provenance FROM chat_gap'), undefined);
  } finally {
    await exact.close();
  }
});
