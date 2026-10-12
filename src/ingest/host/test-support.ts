import assert from 'node:assert/strict';
import { testApp } from '../../../test/harness.ts';
import { loadConfig } from '../../config.ts';
import { createFixtureConnector } from '../../connectors/fixture/index.ts';
import type {
  Connector,
  ConnectorContext,
  ConnectorFactory,
  Ctx,
  Db,
  FixtureLine,
  Host,
  Id,
  MessageRecord,
  OpLog,
  TestApp,
} from '../../contracts/index.ts';
import { createHost } from '../host.ts';

export function deferred<T = void>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export const self = (name: string) => ({ userKey: `self-${name}`, displayName: name, handle: null });
export const chat = (key: string, kind: 'direct' | 'group' | 'broadcast' = 'direct') => ({
  key,
  nativeId: key,
  kind,
  title: `Title ${key}`,
});
export function message(n: number, change: Partial<MessageRecord> = {}): MessageRecord {
  return {
    key: `key-${n}`,
    nativeId: `native-${n}`,
    cursor: String(n).padStart(5, '0'),
    sender: { userKey: 'outside', displayName: 'Outside', handle: '@outside' },
    sentAt: new Date(Date.parse('2026-09-01T10:00:00.000Z') + n * 1000).toISOString(),
    text: `content ${n}`,
    media: null,
    replyToNativeId: null,
    editedAt: null,
    ...change,
  };
}
export function setup(keys = ['selected'], names = ['alice']): FixtureLine[] {
  return names
    .flatMap((name): FixtureLine[] => [
      { t: 'account', account: name, self: self(name) },
      ...keys.map((key): FixtureLine => ({ t: 'chat', account: name, chat: chat(key) })),
    ])
    .concat({ t: 'mark', name: 'setup' });
}
export function delivery(
  account: string,
  chatKey: string,
  m: MessageRecord,
  mode: 'live' | 'missed' | 'history' = 'live',
): FixtureLine {
  return { t: 'message', account, chatKey, message: m, delivery: mode };
}
export function accountId(h: TestApp, username = 'alice'): Id {
  const ctx = h.ctxFor(username);
  assert.equal(ctx.actor.kind, 'teammate');
  const id = h.db.get<{ id: Id }>(
    'SELECT id FROM channel_account WHERE teammate_id=?',
    ctx.actor.kind === 'teammate' ? ctx.actor.id : 0,
  )?.id;
  assert.ok(id);
  return id;
}
export function includedId(h: TestApp, key = 'selected'): Id {
  const id = h.db.get<{ id: Id }>('SELECT id FROM chat WHERE chat_key=?', key)?.id;
  assert.ok(id);
  return id;
}
export async function connect(host: Host, ctx: Ctx, name = 'alice', channel = 'fixture', notice: number | null = null) {
  const { accountId } = await host.beginLogin(ctx, channel, { acknowledgedNoticeVersion: notice });
  assert.equal((await host.continueLogin(ctx, accountId, { account: name })).kind, 'done');
  return accountId;
}
export async function fixtureApp(lines: FixtureLine[], names = ['alice'], settings?: Record<string, unknown>) {
  const h = await testApp({ lines, teammates: names.map((name) => ({ username: name, account: name })), settings });
  await h.control.advanceTo('setup');
  await h.app.host.startAll();
  return h;
}
/** Only connector port control is substituted; DB/auth/graph/log/readers/host are actual. */
export async function controlled(
  lines: FixtureLine[],
  o: {
    decorate?: (c: Connector, ctx: ConnectorContext) => Connector;
    sleep?: (ms: number, h: TestApp) => Promise<void>;
    db?: (db: Db) => Db;
    factory?: ConnectorFactory;
    oplog?: OpLog;
  } = {},
) {
  const h = await testApp({ lines, teammates: [{ username: 'alice' }, { username: 'bob' }] });
  const fixture = createFixtureConnector({ lines });
  const raw = o.factory ?? fixture.factory;
  const contexts = new Map<Id, ConnectorContext>();
  const factory: ConnectorFactory = {
    ...raw,
    create(ctx) {
      contexts.set(ctx.accountId, ctx);
      const c = raw.create(ctx);
      return o.decorate?.(c, ctx) ?? c;
    },
  };
  const db = o.db?.(h.db) ?? h.db;
  const ctx = (name = 'alice'): Ctx => ({ ...h.ctxFor(name), db });
  const sleep = o.sleep
    ? (ms: number) => o.sleep?.(ms, h) ?? Promise.resolve()
    : async (ms: number) => {
        h.clock.advance(ms);
        await new Promise<void>((r) => setImmediate(r));
      };
  const host = createHost({
    db,
    config: loadConfig({ KANBAN_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'), CONNECTORS: factory.channel }),
    connectors: [factory],
    now: h.clock.now,
    sleep,
    oplog: o.oplog ?? (() => {}),
  });
  return { h, host, ctx, contexts, control: fixture.control, factory, sleep };
}
