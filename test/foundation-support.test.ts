import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  credentialForToken,
  getSetting,
  open,
  seal,
  setSetting,
  signIn,
  teammateForSession,
} from '../src/auth/index.ts';
import { createLane, getBoard } from '../src/board/index.ts';
import type { FixtureLine, Model, ModelDecision, ScriptLine } from '../src/contracts/index.ts';
import { getMessages } from '../src/ingest/index.ts';
import { routeInventory } from '../src/web/routes.ts';
import { spineRecording, spineScript } from './fixtures/spine.ts';
import { testApp } from './harness.ts';

async function prepared(t: { after(fn: () => Promise<void>): void }, options: Parameters<typeof testApp>[0] = {}) {
  const h = await testApp({
    lines: spineRecording(),
    script: [],
    teammates: [{ username: 'alice', account: 'alice' }],
    ...options,
  });
  t.after(async () => {
    await h.app.stop();
    h.close();
  });
  return h;
}
async function include(h: Awaited<ReturnType<typeof testApp>>, username = 'alice', key = 'client') {
  const ctx = h.ctxFor(username);
  const account = h.db.get<{ id: number }>(
    'SELECT id FROM channel_account WHERE teammate_id=?',
    ctx.actor.kind === 'teammate' ? ctx.actor.id : null,
  )?.id;
  assert.ok(account);
  await h.app.host.listChats(ctx, account);
  h.app.host.includeChat(ctx, account, key, { agreedWordingVersion: 1, company: null });
  return account;
}

test('F1 auth uses scrypt/hash-only credentials, expiring sessions and authenticated AES-GCM sealing', async (t) => {
  const h = await prepared(t);
  const ctx = h.ctxFor('alice');
  const session = signIn(h.db, 'alice', 'synthetic-password', h.clock.now());
  assert.equal(
    teammateForSession(h.db, session.token, h.clock.now()),
    ctx.actor.kind === 'teammate' ? ctx.actor.id : null,
  );
  assert.throws(() => signIn(h.db, 'alice', 'wrong-password', h.clock.now()), /Invalid sign-in/);
  const token = h.tokenFor({ name: 'auth reader', scopeMessages: true });
  assert.deepEqual(credentialForToken(h.db, token), { id: 1, scopeMessages: true, scopeWrite: false });
  assert.equal(credentialForToken(h.db, `${token}bad`), null);
  assert.ok(!JSON.stringify(h.db.all('SELECT * FROM teammate')).includes('synthetic-password'));
  assert.ok(!JSON.stringify(h.db.all('SELECT * FROM credential')).includes(token.split('_').slice(2).join('_')));
  const key = Buffer.alloc(32, 7);
  const sealed = seal(key, 'synthetic connector session');
  assert.equal(open(key, sealed), 'synthetic connector session');
  assert.ok(!Buffer.from(sealed).includes(Buffer.from('synthetic connector session')));
  const changed = Buffer.from(sealed);
  changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
  assert.throws(() => open(key, changed), /Invalid sealed/);
  assert.throws(() => open(Buffer.alloc(32, 8), sealed), /Invalid sealed/);
  h.clock.advance(15 * 86400000);
  assert.equal(teammateForSession(h.db, session.token, h.clock.now()), null);
  assert.equal(getSetting(h.db, 'review_threshold'), 1);
  assert.throws(() => setSetting({ ...ctx, actor: { kind: 'credential', id: 1 } }, 'review_threshold', 0), /teammate/i);
});

test('F1 all inventory routes authenticate before executing their real or not-built handlers', async (t) => {
  const h = await prepared(t);
  let protectedCount = 0;
  for (const route of routeInventory()) {
    const path = route.path.replace(/:[A-Za-z]+/g, '1');
    const response = route.method === 'GET' ? await h.get(path) : await h.post(path, {});
    if (route.public) assert.ok([200, 422].includes(response.status), `${route.method} ${path}`);
    else {
      protectedCount++;
      assert.equal(response.status, route.method === 'GET' ? 303 : 401, `${route.method} ${path}`);
    }
  }
  assert.ok(protectedCount > 40);
  const wrongOrigin = await h.app.fetch(
    new Request('http://localhost:8787/login', {
      method: 'POST',
      headers: { Origin: 'https://other.invalid' },
      body: new URLSearchParams({ username: 'alice', password: 'synthetic-password' }),
    }),
  );
  assert.equal(wrongOrigin.status, 403);
  const mcp = await h.app.fetch(new Request('http://localhost:8787/mcp', { method: 'POST' }));
  assert.equal(mcp.status, 401);
});

test('F1 initial fixture history is bounded, gate drops excluded content and two accounts store a message once', async (t) => {
  const fixture = spineRecording();
  const sample = fixture.find((l) => l.t === 'message');
  assert.ok(sample?.t === 'message');
  const lines: FixtureLine[] = [
    { t: 'config', pageSize: 1 },
    ...fixture.filter((l) => l.t === 'account' || l.t === 'chat'),
    { t: 'account', account: 'carol', self: { userKey: 'u-carol', displayName: 'Carol', handle: null } },
    {
      t: 'chat',
      account: 'carol',
      chat: { key: 'client', nativeId: 'carol-client', kind: 'group', title: 'Acme integration' },
    },
    { ...sample, delivery: 'history' },
    { t: 'mark', name: 'setup' },
    {
      ...sample,
      message: { ...sample.message, key: 'excluded-marker', nativeId: 'excluded-native', text: 'excluded marker' },
      chatKey: 'excluded',
    },
    sample,
    { ...sample, account: 'carol', message: { ...sample.message, nativeId: 'carol-native' } },
    { ...sample, message: { ...sample.message, nativeId: 'collision-native' } },
    { t: 'mark', name: 'delivered' },
  ];
  const h = await prepared(t, {
    lines,
    teammates: [
      { username: 'alice', account: 'alice' },
      { username: 'carol', account: 'carol' },
    ],
  });
  await h.control.advanceTo('setup');
  await h.app.start();
  const aliceAccount = await include(h);
  await include(h, 'carol');
  await h.app.host.settle();
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM message')?.n, 1);
  await h.control.advanceTo('delivered');
  await h.settle();
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM message')?.n, 2);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM message_sighting')?.n, 3);
  assert.equal(h.db.get('SELECT id FROM message WHERE message_key=?', 'excluded-marker'), undefined);
  assert.equal(h.db.get('SELECT id FROM chat WHERE chat_key=?', 'excluded'), undefined);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM contact')?.n, 1);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM message WHERE message_key=?', 'm-1#2')?.n, 1);
  assert.ok(h.control.calls.some((c) => c.op === 'fetchHistory'));
  assert.equal(h.app.host.chatCounts(h.ctxFor('alice')).undecidedRecent, 1);
  await assert.rejects(h.app.host.listChats(h.ctxFor('carol'), aliceAccount), /owner/);
});

test('F1 default-threshold HTTP acceptance rolls back card/link/log/review together on log failure', async (t) => {
  const h = await prepared(t, { script: spineScript() });
  const ctx = h.ctxFor('alice');
  createLane(ctx, {
    name: 'Sales',
    sop: 'Client integrations',
    stages: [
      { name: 'New', criteria: '' },
      { name: 'Done', criteria: 'Delivered' },
    ],
  });
  await h.control.advanceTo('setup');
  await h.app.start();
  await include(h);
  await h.app.host.settle();
  await h.control.advanceTo('delivered');
  await h.settle();
  const review = h.db.get<{ id: number }>("SELECT id FROM review_item WHERE kind='new_card'");
  assert.ok(review);
  const logs = h.db.get<{ n: number }>('SELECT count(*) AS n FROM action_log')?.n;
  h.db.run(
    "CREATE TRIGGER test_review_fail BEFORE INSERT ON action_log WHEN NEW.action='review.accept' BEGIN SELECT RAISE(ABORT,'injected log failure'); END",
  );
  assert.equal((await h.post(`/review/${review.id}/accept`, {}, { cookie: h.cookieFor('alice') })).status, 500);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM card')?.n, 0);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM card_message')?.n, 0);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM action_log')?.n, logs);
  assert.equal(h.db.get<{ status: string }>('SELECT status FROM review_item WHERE id=?', review.id)?.status, 'open');
  h.db.run('DROP TRIGGER test_review_fail');
  assert.equal((await h.post(`/review/${review.id}/accept`, {}, { cookie: h.cookieFor('alice') })).status, 303);
});

test('F1 supplemental threshold0 applies only admitted create/attach/same-lane move/contact actions', async (t) => {
  const lines = spineRecording();
  const script: ScriptLine[] = [
    {
      messageKey: 'm-1',
      version: 1,
      decision: {
        ...(spineScript()[0] as Extract<ScriptLine, { decision: unknown }>).decision,
        contacts: [
          {
            userKey: 'u-bob',
            company: 'Acme',
            companyConfidence: 1,
            roleCategory: 'technical',
            dealsAbout: 'integration',
            roleConfidence: 1,
            evidenceMessageKeys: ['m-1'],
          },
        ],
      },
    },
    {
      messageKey: 'm-2',
      version: 1,
      decision: {
        ...(spineScript()[0] as Extract<ScriptLine, { decision: unknown }>).decision,
        disposition: 'attach',
        card: 'm-1',
        lane: null,
        title: null,
        summary: null,
        contacts: [],
        move: {
          toStage: 'Delivered',
          criterion: 'Client confirms delivery',
          evidenceMessageKeys: ['m-2'],
          confidence: 1,
        },
      },
    },
  ];
  const h = await prepared(t, { lines, script, settings: { review_threshold: 0 } });
  const ctx = h.ctxFor('alice');
  createLane(ctx, {
    name: 'Sales',
    sop: 'Client integrations',
    stages: [
      { name: 'New', criteria: '' },
      { name: 'Delivered', criteria: 'Client confirms delivery' },
    ],
  });
  await h.control.advanceTo('setup');
  await h.app.start();
  await include(h);
  await h.app.host.settle();
  await h.control.advanceTo('delivered');
  await h.settle();
  const card = getBoard(ctx).lanes[0]?.cards[0];
  assert.ok(card);
  assert.equal(card.stageId, getBoard(ctx).lanes[0]?.stages[1]?.id);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM card_message')?.n, 2);
  assert.equal(
    h.db.get<{ role_category: string }>('SELECT role_category FROM contact WHERE display_name=?', 'Bob')?.role_category,
    'technical',
  );
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM contact_company')?.n, 1);
  const move = h.db.get<{ message_ids: string; reason: string; before: string; after: string }>(
    "SELECT message_ids,reason,before,after FROM action_log WHERE action='card.move'",
  );
  assert.ok(move);
  assert.ok(JSON.parse(move.message_ids).length === 1);
  assert.match(move.reason, /Sales SOP/);
  assert.notEqual(JSON.parse(move.before).stageId, JSON.parse(move.after).stageId);
  const allStored = h.db.all<{ id: number; message_key: string; text: string }>(
    'SELECT id,message_key,text FROM message ORDER BY sent_at DESC,id DESC',
  );
  assert.equal(allStored.length, 12);
  const stored = allStored.filter((m) => ['m-1', 'm-2'].includes(m.message_key));
  assert.equal(stored.length, 2);
  assert.deepEqual(
    stored.map((m) => m.message_key),
    ['m-2', 'm-1'],
  );
  const messages = getMessages(ctx, { ids: stored.map((m) => m.id) });
  assert.deepEqual(
    messages.map((m) => ({ id: m.id, text: m.text, cardId: m.cardId })),
    stored.map((m) => ({ id: m.id, text: m.text, cardId: card.id })),
  );
  const companyId = h.db.get<{ company_id: number }>('SELECT company_id FROM contact_company')?.company_id;
  assert.ok(companyId);
  assert.deepEqual(
    getMessages(ctx, { companyId }).map((m) => ({ id: m.id, text: m.text })),
    allStored.map((m) => ({ id: m.id, text: m.text })),
  );
  assert.ok(messages.every((m) => m.sender.name === 'Bob' && m.direction === 'in'));
  assert.ok(
    getMessages({ ...ctx, canReadText: false }, { ids: stored.map((m) => m.id) }).every((m) => m.text === null),
  );
});

test('F1 stop aborts in-flight scripted-boundary work and discards a late model reply', async (t) => {
  let resolve: (value: ModelDecision) => void = () => {};
  let signal: AbortSignal | undefined;
  const result = new Promise<ModelDecision>((r) => {
    resolve = r;
  });
  const model: Model = {
    name: 'controlled',
    endpointHost: null,
    blocked: null,
    async decide(_input, s) {
      signal = s;
      return result;
    },
  };
  const h = await prepared(t, { model, script: undefined });
  await h.control.advanceTo('setup');
  await h.app.start();
  await include(h);
  await h.app.host.settle();
  await h.control.advanceTo('delivered');
  const processing = h.app.pipeline.processNext();
  assert.ok(signal);
  const stop = h.app.pipeline.stop();
  assert.equal(signal.aborted, true);
  resolve({
    disposition: 'none',
    cardId: null,
    proposalId: null,
    laneId: null,
    title: null,
    summary: null,
    cardCompanyId: null,
    cardCompanyName: null,
    confidence: 1,
    reason: 'late',
    move: null,
    contacts: [],
    mentions: [],
  });
  await stop;
  assert.equal(await processing, null);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM decision')?.n, 0);
  assert.equal(h.app.pipeline.status().pending, 12);
});

test('F1 harness restart rebuilds instance state over retained DB without replaying stored messages', async (t) => {
  const h = await prepared(t);
  await h.control.advanceTo('setup');
  await h.app.start();
  await include(h);
  await h.app.host.settle();
  await h.control.advanceTo('delivered');
  await h.settle();
  const old = h.app;
  await h.restart();
  assert.notEqual(h.app, old);
  await h.settle();
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM message')?.n, 12);
  assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM decision')?.n, 12);
  assert.equal(h.app.pipeline.status().pending, 0);
  assert.equal(h.app.host.chatCounts(h.ctxFor('alice')).connected, true);
});

test('F1 real CLI replay assembles fixture/script/pipeline offline at default threshold1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-replay-'));
  try {
    const recording = join(dir, 'recording.jsonl'),
      script = join(dir, 'script.jsonl'),
      setup = join(dir, 'setup.json');
    writeFileSync(
      recording,
      spineRecording()
        .map((l) => JSON.stringify(l))
        .join('\n'),
    );
    writeFileSync(
      script,
      spineScript()
        .map((l) => JSON.stringify(l))
        .join('\n'),
    );
    writeFileSync(
      setup,
      JSON.stringify({
        teammates: [{ username: 'alice', account: 'alice' }],
        lanes: [
          {
            name: 'Sales',
            sop: 'Client integrations',
            stages: [
              { name: 'New', criteria: '' },
              { name: 'Done', criteria: 'Delivered' },
            ],
          },
        ],
        included: [{ account: 'alice', chatKey: 'client', company: null }],
        settings: {},
      }),
    );
    const { stdout } = await promisify(execFile)(process.execPath, ['src/cli.ts', 'replay', recording, setup, script], {
      cwd: new URL('../', import.meta.url).pathname,
    });
    assert.deepEqual(JSON.parse(stdout), { messages: 12, decisions: 12, cards: 0, reviews: 3, contacts: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
