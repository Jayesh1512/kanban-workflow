import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Ctx } from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';
import { history, record } from '../log/index.ts';
import { openDb } from '../store/index.ts';
import {
  addTeammate,
  createCredential,
  credentialForToken,
  getSetting,
  listCredentials,
  listTeammates,
  open,
  removeTeammate,
  revokeCredential,
  seal,
  setSetting,
  signIn,
  signOut,
  teammateForSession,
} from './index.ts';

function fixture(t: { after(fn: () => void): void }) {
  const db = openDb(':memory:');
  t.after(() => db.close());
  const now = () => new Date('2026-10-10T10:00:00.000Z');
  const system: Ctx = { db, actor: { kind: 'system' }, now, canReadText: true };
  const a = addTeammate(system, { username: 'alice', displayName: 'Alice', password: 'secret-marker-password' });
  const b = addTeammate(system, { username: 'bob', displayName: 'Bob', password: 'synthetic-bob' });
  return { db, now, system, a, b, ctx: { ...system, actor: { kind: 'teammate' as const, id: a } } };
}

test('I1 R26.2/4 full auth enforces actors, salted scrypt, hash-only sessions/credentials and exact expiry', (t) => {
  const { db, now, ctx, a, system } = fixture(t);
  assert.deepEqual(
    listTeammates(ctx).map((v) => v.username),
    ['alice', 'bob'],
  );
  for (const actor of [
    { kind: 'agent' as const },
    { kind: 'credential' as const, id: 1 },
    { kind: 'teammate' as const, id: 999 },
  ]) {
    assert.throws(() => addTeammate({ ...ctx, actor }, { username: 'x', displayName: 'x', password: 'x' }), {
      code: 'forbidden',
    });
    assert.throws(() => setSetting({ ...ctx, actor }, 'review_threshold', 0.8), { code: 'forbidden' });
    assert.throws(() => createCredential({ ...ctx, actor }, { name: 'x', scopeMessages: false }), {
      code: 'forbidden',
    });
  }
  assert.throws(() => createCredential(system, { name: 'x', scopeMessages: false }), { code: 'forbidden' });
  assert.throws(() => signIn(db, 'missing', 'x', now()), { code: 'unauthenticated' });
  assert.throws(() => signIn(db, 'alice', 'wrong', now()), { code: 'unauthenticated' });
  const session = signIn(db, 'alice', 'secret-marker-password', now());
  assert.equal(teammateForSession(db, session.token, now()), a);
  assert.equal(teammateForSession(db, session.token, new Date(session.expiresAt)), null);
  assert.equal(session.token.length, 43);
  assert.equal(
    db.get<{ token_hash: string }>('SELECT token_hash FROM web_session')?.token_hash,
    createHash('sha256').update(session.token).digest('hex'),
  );
  signOut(db, session.token);
  signOut(db, session.token);
  assert.equal(teammateForSession(db, session.token, now()), null);
  const issued = createCredential(ctx, { name: 'reader', scopeMessages: false });
  assert.deepEqual(credentialForToken(db, issued.token), { id: issued.id, scopeMessages: false, scopeWrite: false });
  assert.deepEqual(listCredentials(ctx), [
    { id: issued.id, name: 'reader', scopeMessages: false, scopeWrite: false, createdBy: 'Alice', revoked: false },
  ]);
  const dump = JSON.stringify([
    db.all('SELECT * FROM teammate'),
    db.all('SELECT * FROM web_session'),
    db.all('SELECT * FROM credential'),
    history(ctx, {}),
  ]);
  assert.ok(!dump.includes('secret-marker-password'));
  assert.ok(!dump.includes(issued.token));
  assert.ok(!dump.includes(issued.token.slice(issued.token.indexOf('_', 4) + 1)));
  revokeCredential(ctx, issued.id);
  revokeCredential(ctx, issued.id);
  assert.equal(credentialForToken(db, issued.token), null);
  assert.equal(history(ctx, { action: 'credential.revoke' }).length, 1);
});

test('I1 R26.3 controlled disconnect follows committed removal/log/session revocation with system actor', async (t) => {
  const { db, now, ctx, a, b } = fixture(t);
  const bob = { ...ctx, actor: { kind: 'teammate' as const, id: b } };
  const token = signIn(db, 'bob', 'synthetic-bob', now()).token;
  const credential = createCredential(bob, { name: 'bob-reader', scopeMessages: true });
  db.tx(() => {
    for (const key of ['one', 'two'])
      db.run(
        'INSERT INTO channel_account(teammate_id,channel,state,created_at) VALUES (?, ?, ?, ?)',
        b,
        key,
        'connected',
        now().toISOString(),
      );
  });
  const calls: number[] = [];
  await removeTeammate(ctx, b, async (id) => {
    calls.push(id);
    assert.equal(teammateForSession(db, token, now()), null);
    assert.equal(credentialForToken(db, credential.token), null);
    assert.equal(history(ctx, { action: 'teammate.remove' })[0]?.subjectId, b);
    const system = { ...ctx, actor: { kind: 'system' as const } };
    db.tx(() => record(system, { action: 'account.disconnect', subjectKind: 'account', subjectId: id }));
  });
  assert.equal(calls.length, 2);
  const entries = history(ctx, {});
  assert.ok(entries.filter((v) => v.action === 'account.disconnect').every((v) => v.actor.kind === 'system'));
  assert.ok(
    (entries.find((v) => v.action === 'account.disconnect')?.id ?? 0) >
      (entries.find((v) => v.action === 'teammate.remove')?.id ?? 0),
  );
  assert.deepEqual(
    listTeammates(ctx).map((v) => v.id),
    [a],
  );
  assert.throws(() => createCredential(bob, { name: 'removed', scopeMessages: false }), { code: 'forbidden' });
  await assert.rejects(
    removeTeammate(ctx, b, async () => {}),
    { code: 'not_found' },
  );
});

test('I1 removal rolls back with its log; callback failure is secret-free and attempts all accounts', async (t) => {
  const { db, now, ctx, b } = fixture(t);
  db.tx(() => {
    for (const key of ['one', 'two'])
      db.run(
        'INSERT INTO channel_account(teammate_id,channel,state,created_at) VALUES (?, ?, ?, ?)',
        b,
        key,
        'connected',
        now().toISOString(),
      );
  });
  const base = db.run;
  db.run = (sql, ...params) => {
    if (sql.startsWith('INSERT INTO action_log')) throw new Error('synthetic log failure');
    return base(sql, ...params);
  };
  let calls = 0;
  await assert.rejects(
    removeTeammate(ctx, b, async () => {
      calls++;
    }),
    /synthetic log failure/,
  );
  assert.equal(
    db.get<{ removed_at: string | null }>('SELECT removed_at FROM teammate WHERE id=?', b)?.removed_at,
    null,
  );
  assert.equal(calls, 0);
  db.run = base;
  await assert.rejects(
    removeTeammate(ctx, b, async () => {
      calls++;
      throw new Error('private callback marker');
    }),
    (error) => error instanceof AppError && error.message === 'Teammate removed; account disconnect incomplete',
  );
  assert.equal(calls, 2);
});

test('I1 R13 settings defaults, validation and AES-GCM tamper rejection', (t) => {
  const { db, ctx } = fixture(t);
  assert.equal(getSetting(db, 'review_threshold'), 1);
  assert.equal(getSetting(db, 'require_agreement'), true);
  for (const value of [-1, 1.1, NaN, '0.8'])
    assert.throws(() => setSetting(ctx, 'review_threshold', value), { code: 'invalid' });
  assert.throws(() => setSetting(ctx, 'role_categories', ['other']), { code: 'invalid' });
  setSetting(ctx, 'review_threshold', 0.8);
  assert.equal(getSetting(db, 'review_threshold'), 0.8);
  assert.equal(history(ctx, { action: 'setting.update' }).length, 1);
  const key = Buffer.alloc(32, 8);
  const first = seal(key, 'sealed-marker');
  const second = seal(key, 'sealed-marker');
  assert.notDeepEqual(first, second);
  assert.equal(open(key, first), 'sealed-marker');
  assert.ok(!Buffer.from(first).includes(Buffer.from('sealed-marker')));
  assert.throws(() => open(Buffer.alloc(32, 9), first), { code: 'invalid' });
  first[28] = (first[28] ?? 0) ^ 1;
  assert.throws(() => open(key, first), { code: 'invalid' });
  assert.throws(() => open(key, new Uint8Array(27)), { code: 'invalid' });
});
