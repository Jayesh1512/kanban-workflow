import assert from 'node:assert/strict';
import { addTeammate } from '../../auth/index.ts';
import { loadConfig } from '../../config.ts';
import type { ConnectorFactory, Ctx, EventSink, HistoryRequest } from '../../contracts/index.ts';
import { openDb } from '../../store/index.ts';
import { createHost } from '../host.ts';
import { getMessages } from '../index.ts';
import { chat, message, self } from './test-support.ts';

// This controlled worker is the ONLY writer, and exits after the real page COMMIT,
// at the next iterator demand, before throwing or entering a failure/gap transaction.
const [mode, path] = process.argv.slice(2);
assert.ok(path);
const db = openDb(path);
const now = () => new Date('2026-09-01T10:00:00.000Z');
let sink: EventSink | undefined;
let phase = mode === 'crash' ? 'empty' : 'resume';
const requests: HistoryRequest[] = [];
const factory: ConnectorFactory = {
  channel: 'fixture',
  label: 'Controlled crash recording',
  loginNotice: () => null,
  capabilities: { history: true, edits: true, deletions: true },
  pace: { minRequestIntervalMs: 0, pageSize: 1 },
  create(ctx) {
    return {
      async login(input) {
        if (!input)
          return { kind: 'need_input', fields: [{ name: 'account', label: 'Account', secret: false }], hint: '' };
        ctx.saveSession('opaque controlled session');
        return { kind: 'done', self: self('alice') };
      },
      async start(next) {
        sink = next;
        if (mode === 'resume')
          await next.emit({
            type: 'message',
            chat: chat('selected'),
            message: message(90, { cursor: 'opaque-live-advance' }),
          });
      },
      async stop() {},
      async logout() {
        ctx.saveSession(null);
      },
      async listChats() {
        return [
          {
            chat: chat('selected'),
            latestAt: message(3).sentAt,
            latestCursor: phase === 'empty' ? null : 'opaque-head',
          },
        ];
      },
      async *fetchHistory(req) {
        requests.push(req);
        if (phase === 'empty') return;
        if (mode === 'crash') {
          assert.equal(req.after, 'opaque-original-after');
          yield {
            messages: [message(3, { replyToNativeId: 'native-2', cursor: 'opaque-head' })],
            resume: 'opaque-below-source',
          };
          assert.equal(db.get<{ n: number }>('SELECT count(*) AS n FROM message')?.n, 2);
          assert.equal(db.get<{ n: number }>('SELECT count(*) AS n FROM chat_gap')?.n, 0);
          process.stdout.write(JSON.stringify({ phase: 'committed-before-failure', pid: process.pid }));
          process.exit(0);
        }
        assert.equal(req.resume, 'opaque-below-source');
        assert.equal(req.after, 'opaque-original-after');
        assert.equal(req.since, null);
        assert.equal(req.limit, null);
        yield { messages: [message(2, { cursor: 'opaque-tail' })], resume: null };
      },
    };
  },
};
const host = createHost({
  db,
  now,
  sleep: async () => {},
  connectors: [factory],
  config: loadConfig({ KANBAN_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'), CONNECTORS: 'fixture' }),
  oplog: () => {},
});
const system: Ctx = { db, now, actor: { kind: 'system' }, canReadText: true };
if (mode === 'crash') addTeammate(system, { username: 'alice', displayName: 'Alice', password: 'synthetic-password' });
const ctx: Ctx = { ...system, actor: { kind: 'teammate', id: 1 } };
if (mode === 'crash') {
  const { accountId } = await host.beginLogin(ctx, 'fixture', { acknowledgedNoticeVersion: null });
  await host.continueLogin(ctx, accountId, { account: 'alice' });
  await host.startAll();
  host.includeChat(ctx, accountId, 'selected', { agreedWordingVersion: 1, company: null });
  await host.settle();
  await sink?.emit({
    type: 'message',
    chat: chat('selected'),
    message: message(1, { cursor: 'opaque-original-after' }),
  });
  await host.stopAll();
  phase = 'history';
  await host.startAll();
  await host.settle();
  throw new Error('Crash boundary was not reached');
} else {
  await host.startAll();
  await host.settle();
  const messages = getMessages(ctx, { limit: 100 });
  const source = messages.find((m) => m.sentAt === message(3).sentAt);
  const target = messages.find((m) => m.sentAt === message(2).sentAt);
  assert.ok(source && target);
  assert.equal(source.replyToId, target.id, 'fresh-process resume below source must resolve durable reply exactly');
  assert.equal(messages.length, 4);
  assert.equal(db.get<{ n: number }>('SELECT count(*) AS n FROM message_sighting')?.n, 4);
  const gap = db.get<{ from_time: string; bound_provenance: string; closed_at: string }>('SELECT * FROM chat_gap');
  assert.equal(
    gap?.from_time,
    message(1).sentAt,
    'original pre-dispatch shared maximum survives live advance and crash',
  );
  assert.equal(gap?.bound_provenance, 'exact');
  assert.ok(gap?.closed_at);
  assert.equal(requests.length, 1);
  await host.stopAll();
  db.close();
  process.stdout.write(JSON.stringify({ phase: 'resumed-exactly-once', pid: process.pid }));
}
