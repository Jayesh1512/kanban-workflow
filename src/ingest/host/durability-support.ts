import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addTeammate } from '../../auth/index.ts';
import { loadConfig } from '../../config.ts';
import { createFixtureConnector } from '../../connectors/fixture/index.ts';
import type { Connector, ConnectorContext, Ctx, EventSink, FixtureLine, Id } from '../../contracts/index.ts';
import { openDb } from '../../store/index.ts';
import { createHost } from '../host.ts';
import { connect, setup } from './test-support.ts';

/** Exclusive new file identity; old-source probes MUST use a different root/identity. */
export function exclusiveFile() {
  const prefix = process.env.H1_RUNTIME_TEST_ROOT
    ? join(process.env.H1_RUNTIME_TEST_ROOT, 'fixture-')
    : fileURLToPath(new URL('../../../../.h1-runtime-fixture-', import.meta.url));
  const directory = mkdtempSync(prefix);
  const path = join(directory, 'exclusive-new.db');
  assert.equal(existsSync(path), false);
  const handles = spawnSync('lsof', ['-t', path], { encoding: 'utf8' });
  assert.equal(handles.error, undefined);
  assert.equal(handles.stdout.trim(), '');
  const consumer = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)),
    encoding: 'utf8',
  });
  assert.equal(consumer.status, 0);
  process.stdout.write(
    `H1_DB_FENCE ${JSON.stringify({ path, pid: process.pid, consumer: consumer.stdout.trim(), absent: true, handles: 0, oldWriterReuse: false })}\n`,
  );
  return { directory, path };
}
export function assertNoHandles(path: string) {
  const result = spawnSync('lsof', ['-t', path], { encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.stdout.trim(), '', 'predecessor process/DB handles must close before successor opens');
}
export async function durabilityRig(
  o: {
    keys?: string[];
    names?: string[];
    lines?: FixtureLine[];
    decorate?: (c: Connector, ctx: ConnectorContext) => Connector;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const names = o.names ?? ['alice', 'bob'];
  const f = exclusiveFile();
  const db = openDb(f.path);
  let time = Date.parse('2026-09-01T10:00:00.000Z');
  const now = () => new Date(time);
  const system: Ctx = { db, now, actor: { kind: 'system' }, canReadText: true };
  const owners = new Map(
    names.map((name) => [
      name,
      addTeammate(system, { username: name, displayName: name, password: 'synthetic-password' }),
    ]),
  );
  const ctx = (name = 'alice'): Ctx => ({ ...system, actor: { kind: 'teammate', id: owners.get(name) ?? 0 } });
  const fixture = createFixtureConnector({ lines: o.lines ?? setup(o.keys ?? ['selected'], names) });
  const sinks = new Map<Id, EventSink>();
  const contexts = new Map<Id, ConnectorContext>();
  const factory = {
    ...fixture.factory,
    create(cctx: ConnectorContext) {
      contexts.set(cctx.accountId, cctx);
      const original = fixture.factory.create(cctx);
      const c = o.decorate?.(original, cctx) ?? original;
      return {
        ...c,
        async start(sink: EventSink) {
          sinks.set(cctx.accountId, sink);
          await c.start(sink);
        },
      };
    },
  };
  const config = loadConfig({ KANBAN_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'), CONNECTORS: 'fixture' });
  const sleep =
    o.sleep ??
    (async (ms: number) => {
      time += ms;
    });
  const build = () => createHost({ db, now, sleep, config, connectors: [factory], oplog: () => {} });
  const host = build();
  await fixture.control.advanceTo('setup');
  const accounts = new Map<string, Id>();
  for (const name of names) accounts.set(name, await connect(host, ctx(name), name));
  await host.startAll();
  return {
    ...f,
    db,
    now,
    ctx,
    system,
    host,
    build,
    accounts,
    contexts,
    sinks,
    control: fixture.control,
    advance(ms: number) {
      time += ms;
    },
    chatId(key = 'selected') {
      const id = db.get<{ id: Id }>('SELECT id FROM chat WHERE chat_key=?', key)?.id;
      assert.ok(id);
      return id;
    },
    include(name = 'alice', key = 'selected') {
      host.includeChat(ctx(name), accounts.get(name) ?? 0, key, { agreedWordingVersion: 1, company: null });
    },
    async close() {
      await host.stopAll();
      db.close();
      assertNoHandles(f.path);
      rmSync(f.directory, { recursive: true, force: true });
    },
  };
}
export type DurabilityRig = Awaited<ReturnType<typeof durabilityRig>>;
