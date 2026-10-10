import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { createModel, createMovementProvider } from './agent/index.ts';
import { createApp } from './app.ts';
import { addTeammate, setSetting } from './auth/index.ts';
import { createLane } from './board/index.ts';
import { createFixtureConnector } from './connectors/fixture/index.ts';
import type { AppConfig, Ctx, Id } from './contracts/index.ts';
import { AppError, FixtureLineSchema } from './contracts/index.ts';
import { openDb } from './store/index.ts';

/** Assembly for the admitted offline CLI replay, using the same component factories as the server. */
export async function runReplay(
  config: AppConfig,
  recording: string,
  setup: string,
  script: string,
): Promise<{ messages: number; decisions: number; cards: number; reviews: number; contacts: number }> {
  const lines = readFileSync(recording, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => FixtureLineSchema.parse(JSON.parse(l)));
  const input = z
    .strictObject({
      teammates: z.array(z.strictObject({ username: z.string().min(1), account: z.string().min(1) })).min(1),
      lanes: z.array(
        z.strictObject({
          name: z.string(),
          sop: z.string(),
          stages: z.array(z.strictObject({ name: z.string(), criteria: z.string() })),
        }),
      ),
      included: z.array(z.strictObject({ account: z.string(), chatKey: z.string(), company: z.string().nullable() })),
      settings: z.record(z.string(), z.unknown()),
    })
    .parse(JSON.parse(readFileSync(setup, 'utf8')));
  const mark = 'foundation_cli_setup';
  if (lines.some((l) => l.t === 'mark' && l.name === mark)) throw new AppError('invalid', 'Reserved CLI mark exists');
  const firstContent = lines.findIndex((l) => ['message', 'edit', 'delete', 'history_error'].includes(l.t));
  lines.splice(firstContent < 0 ? lines.length : firstContent, 0, { t: 'mark', name: mark });
  const fixture = createFixtureConnector({ lines });
  const db = openDb(':memory:');
  const now = () => new Date();
  const sleep = async (ms: number) => {
    await setTimeout(ms);
  };
  const oplog = () => {};
  const sibling = join(dirname(script), 'movement.jsonl');
  const path = config.movement.replayPath ?? (existsSync(sibling) ? sibling : null);
  const replayConfig: AppConfig = {
    ...config,
    connectors: { fixture: {} },
    model: { ...config.model, provider: 'scripted', scriptPath: script },
    movement: { ...config.movement, provider: 'replay', replayPath: path },
  };
  let app: ReturnType<typeof createApp> | undefined;
  try {
    const model = await createModel(replayConfig.model, { db, oplog });
    const movement = await createMovementProvider(replayConfig.movement, {
      db,
      oplog,
      now,
      sleep,
      http: {
        async post() {
          throw new AppError('invalid', 'not built: movementHttp');
        },
      },
      ...(path === null ? { replayLines: [] } : {}),
    });
    app = createApp({ db, model, movement, connectors: [fixture.factory], config: replayConfig, now, sleep, oplog });
    const system: Ctx = { db, now, actor: { kind: 'system' }, canReadText: true };
    const accounts = new Map<string, { id: Id; ctx: Ctx }>();
    for (const t of input.teammates) {
      const id = addTeammate(system, {
        username: t.username,
        displayName: t.username,
        password: 'synthetic-replay-only',
      });
      const ctx: Ctx = { ...system, actor: { kind: 'teammate', id } };
      const login = await app.host.beginLogin(ctx, 'fixture', { acknowledgedNoticeVersion: null });
      const result = await app.host.continueLogin(ctx, login.accountId, { account: t.account });
      if (result.kind !== 'done') throw new AppError('invalid', 'CLI fixture login failed');
      if (accounts.has(t.account)) throw new AppError('invalid', 'Duplicate replay account');
      accounts.set(t.account, { id: login.accountId, ctx });
    }
    const first = accounts.values().next().value;
    if (!first) throw new AppError('invalid', 'Replay teammate required');
    for (const [key, value] of Object.entries(input.settings)) setSetting(first.ctx, key, value);
    for (const l of input.lanes) createLane(first.ctx, l);
    await fixture.control.advanceTo(mark);
    for (const a of accounts.values()) await app.host.listChats(a.ctx, a.id);
    for (const included of input.included) {
      const a = accounts.get(included.account);
      if (!a) throw new AppError('invalid', 'Unknown replay account');
      app.host.includeChat(a.ctx, a.id, included.chatKey, { agreedWordingVersion: 1, company: included.company });
    }
    await app.host.settle();
    await app.start();
    await fixture.control.advanceTo('end');
    await app.host.settle();
    await app.pipeline.drain();
    const count = (sql: string) => db.get<{ n: number }>(sql)?.n ?? 0;
    return {
      messages: count('SELECT count(*) AS n FROM message'),
      decisions: count('SELECT count(*) AS n FROM decision'),
      cards: count('SELECT count(*) AS n FROM card'),
      reviews: count("SELECT count(*) AS n FROM review_item WHERE status='open'"),
      contacts: count('SELECT count(*) AS n FROM contact'),
    };
  } finally {
    if (app) await app.stop();
    db.close();
  }
}
