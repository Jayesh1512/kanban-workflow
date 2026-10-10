import { createModel, createMovementProvider } from '../src/agent/index.ts';
import { createApp } from '../src/app.ts';
import { addTeammate, createCredential, setSetting, signIn } from '../src/auth/index.ts';
import { loadConfig } from '../src/config.ts';
import { createFixtureConnector } from '../src/connectors/fixture/index.ts';
import type {
  Ctx,
  FixtureLine,
  IsoTime,
  Model,
  MovementDecisionProvider,
  MovementReplayLine,
  OpenAIResponsesPort,
  ScriptLine,
  TestApp,
} from '../src/contracts/index.ts';
import { AppError } from '../src/contracts/index.ts';
import { openDb } from '../src/store/index.ts';

export type { TestApp } from '../src/contracts/index.ts';

export async function testApp(o?: {
  lines?: FixtureLine[];
  recordingPath?: string;
  script?: ScriptLine[];
  scriptPath?: string;
  model?: Model;
  openai?: OpenAIResponsesPort;
  movement?: MovementDecisionProvider;
  movementReplay?: MovementReplayLine[];
  movementReplayPath?: string;
  teammates?: { username: string; account?: string }[];
  settings?: Record<string, unknown>;
  start?: IsoTime;
}): Promise<TestApp> {
  const options = o ?? {};
  if (options.lines !== undefined && options.recordingPath !== undefined)
    throw new AppError('invalid', 'Choose one fixture source');
  if ([options.script, options.scriptPath, options.model, options.openai].filter((v) => v !== undefined).length > 1)
    throw new AppError('invalid', 'Choose one model source');
  if ([options.movement, options.movementReplay, options.movementReplayPath].filter((v) => v !== undefined).length > 1)
    throw new AppError('invalid', 'Choose one movement source');
  let at = new Date(options.start ?? '2026-09-01T10:00:00.000Z').getTime();
  if (!Number.isFinite(at)) throw new AppError('invalid', 'Invalid test clock');
  const clock = {
    now: () => new Date(at),
    advance(ms: number) {
      at += ms;
    },
  };
  const sleep = async (ms: number) => {
    clock.advance(ms);
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const config = loadConfig({
    KANBAN_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
    CONNECTORS: 'fixture',
    MODEL_PROVIDER: options.openai ? 'openai' : 'scripted',
    MODEL_SCRIPT_PATH: options.scriptPath,
    MOVEMENT_PROVIDER: 'replay',
    MOVEMENT_REPLAY_PATH: options.movementReplayPath,
  });
  if (options.openai) {
    config.model.name = 'synthetic-injected-model';
    config.model.apiKey = 'synthetic-test-key';
  }
  const oplog = () => {};
  const fixture = createFixtureConnector(
    options.recordingPath !== undefined ? { path: options.recordingPath } : { lines: options.lines ?? [] },
  );
  const db = openDb(':memory:');
  const ids = new Map<string, number>();
  const cookies = new Map<string, string>();
  const system: Ctx = { db, actor: { kind: 'system' }, canReadText: true, now: clock.now };
  const build = async () => {
    const model =
      options.model ??
      (await createModel(config.model, {
        db,
        oplog,
        ...(options.scriptPath || options.openai ? {} : { scriptLines: options.script ?? [] }),
        ...(options.openai ? { openai: options.openai } : {}),
      }));
    const movement =
      options.movement ??
      (await createMovementProvider(config.movement, {
        db,
        oplog,
        now: clock.now,
        sleep,
        http: {
          async post() {
            throw new Error('External network blocked in testApp');
          },
        },
        ...(options.movementReplayPath ? {} : { replayLines: options.movementReplay ?? [] }),
      }));
    return createApp({ db, config, model, movement, connectors: [fixture.factory], now: clock.now, sleep, oplog });
  };
  try {
    for (const teammate of options.teammates ?? []) {
      const id = addTeammate(system, {
        username: teammate.username,
        displayName: teammate.username,
        password: 'synthetic-password',
      });
      ids.set(teammate.username, id);
      cookies.set(
        teammate.username,
        `kanban_session=${signIn(db, teammate.username, 'synthetic-password', clock.now()).token}`,
      );
    }
    for (const [key, value] of Object.entries(options.settings ?? {})) {
      const id = ids.values().next().value;
      if (id === undefined) throw new AppError('invalid', 'Test settings need a named teammate');
      setSetting({ ...system, actor: { kind: 'teammate', id } }, key, value);
    }
    let app = await build();
    let closed = false;
    const helper: TestApp = {
      app,
      db,
      control: fixture.control,
      clock,
      ctxFor(username) {
        const id = ids.get(username);
        if (id === undefined) throw new AppError('not_found', 'Unknown test teammate');
        return { ...system, actor: { kind: 'teammate', id } };
      },
      cookieFor(username) {
        const cookie = cookies.get(username);
        if (!cookie) throw new AppError('not_found', 'Unknown test teammate');
        return cookie;
      },
      tokenFor(i) {
        const username = ids.keys().next().value;
        if (username === undefined) throw new AppError('invalid', 'Test credential needs a teammate');
        return createCredential(helper.ctxFor(username), i).token;
      },
      get(path, o = {}) {
        const headers = new Headers();
        if (o.cookie) headers.set('Cookie', o.cookie);
        if (o.bearer) headers.set('Authorization', `Bearer ${o.bearer}`);
        return app.fetch(new Request(`${config.origin}${path}`, { headers }));
      },
      post(path, form, o = {}) {
        const headers = new Headers({ Origin: config.origin });
        if (o.cookie) headers.set('Cookie', o.cookie);
        return app.fetch(
          new Request(`${config.origin}${path}`, { method: 'POST', headers, body: new URLSearchParams(form) }),
        );
      },
      async mcp(tool, args, bearer) {
        const response = await app.fetch(
          new Request(`${config.origin}/mcp`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${bearer}`,
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
              'MCP-Protocol-Version': '2026-07-28',
              'Mcp-Method': 'tools/call',
              'Mcp-Name': tool,
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name: tool,
                arguments: args,
                _meta: {
                  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                  'io.modelcontextprotocol/clientCapabilities': {},
                  'io.modelcontextprotocol/clientInfo': { name: 'kanban-test', version: '0.0.0' },
                },
              },
            }),
          }),
        );
        if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${await response.text()}`);
        const envelope: unknown = await response.json();
        if (
          !envelope ||
          typeof envelope !== 'object' ||
          !('result' in envelope) ||
          !envelope.result ||
          typeof envelope.result !== 'object' ||
          !('structuredContent' in envelope.result)
        )
          throw new Error('MCP tool did not return structuredContent');
        return envelope.result.structuredContent;
      },
      async settle() {
        await app.host.settle();
        await app.pipeline.drain();
      },
      async restart() {
        if (closed) throw new AppError('invalid', 'Test app is closed');
        await app.stop();
        app = await build();
        helper.app = app;
        await app.start();
      },
      close() {
        if (closed) return;
        closed = true;
        void app.stop().then(() => db.close());
      },
    };
    for (const teammate of options.teammates ?? [])
      if (teammate.account) {
        const { accountId } = await app.host.beginLogin(helper.ctxFor(teammate.username), 'fixture', {
          acknowledgedNoticeVersion: null,
        });
        await app.host.continueLogin(helper.ctxFor(teammate.username), accountId, { account: teammate.account });
      }
    return helper;
  } catch (error) {
    db.close();
    throw error;
  }
}
