import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { createApp } from '../app.ts';
import { addTeammate, setSetting, signIn } from '../auth/index.ts';
import { createLane } from '../board/index.ts';
import { loadConfig } from '../config.ts';
import { createFixtureConnector } from '../connectors/fixture/index.ts';
import type {
  Ctx,
  DecideInput,
  FixtureLine,
  ModelDecision,
  MovementRequest,
  MovementResult,
  OpenAIResponseRequest,
} from '../contracts/index.ts';
import { DecideInputSchema, OpenAIResponseRequestSchema } from '../contracts/index.ts';
import { openDb } from '../store/index.ts';
import { createMovementHttpPort, createOpenAIResponsesPort } from '../store/provider-ports.ts';
import { createModel, createMovementProvider } from './index.ts';

export function decision(input: DecideInput, fields: Partial<ModelDecision> = {}): ModelDecision {
  return {
    disposition: 'create',
    cardId: null,
    proposalId: null,
    laneId: input.lanes[0]?.id ?? null,
    title: 'Synthetic integration',
    summary: 'A customer requests integration work.',
    cardCompanyId: null,
    cardCompanyName: null,
    confidence: 1,
    reason: 'Synthetic work evidence',
    move: null,
    contacts: [],
    mentions: [],
    ...fields,
  };
}
export function completed(value: unknown): unknown {
  return {
    id: 'synthetic-response',
    object: 'response',
    status: 'completed',
    error: null,
    output: [
      {
        id: 'synthetic-message',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: JSON.stringify(value), annotations: [] }],
      },
    ],
  };
}
export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
export type Questions = Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string> }>;
export type WireRequest = { model: string; state: string; questions: Questions };
export function jevAnswer(body: WireRequest, selected = 'stay', confidence = 1, supportChoice?: string): unknown {
  const state = JSON.parse(body.state) as Pick<MovementRequest, 'evidenceOptions'>;
  const answers = Object.fromEntries(
    Object.entries(body.questions).map(([id, q]) => {
      const chosen =
        id === 'movement'
          ? selected
          : id === `support:${selected}`
            ? (supportChoice ?? state.evidenceOptions[0]?.id ?? 'review')
            : 'review';
      return [
        id,
        {
          type: 'choice',
          choice: chosen,
          confidence,
          probabilities: Object.fromEntries(Object.keys(q.criteria).map((key) => [key, Number(key === chosen)])),
        },
      ];
    }),
  );
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 300, output_tokens: 30 } };
}
export function recording(text = 'Synthetic integration request', otherText = text): FixtureLine[] {
  return [
    { t: 'account', account: 'alice', self: { userKey: 'self', displayName: 'Alice', handle: null } },
    ...['work', 'other'].map(
      (key): FixtureLine => ({
        t: 'chat',
        account: 'alice',
        chat: { key, nativeId: key, kind: 'group', title: `Synthetic ${key}` },
      }),
    ),
    { t: 'mark', name: 'setup' },
    ...['one', 'two', 'three', 'other'].flatMap((key, i): FixtureLine[] => [
      {
        t: 'message',
        account: 'alice',
        delivery: 'live',
        chatKey: key === 'other' ? 'other' : 'work',
        message: {
          key,
          nativeId: key,
          cursor: String(i + 1),
          sender: { userKey: 'outside', displayName: 'Outside', handle: null },
          sentAt: `2026-09-01T10:00:0${i + 1}.000Z`,
          text: key === 'other' ? otherText : text,
          media: null,
          replyToNativeId: null,
          editedAt: null,
        },
      },
      { t: 'mark', name: key },
    ]),
  ];
}
export async function cloudFixture(
  t: TestContext,
  options: {
    gateway?: boolean;
    attempts?: 1 | 2;
    movementAttempts?: 1 | 2;
    threshold?: number;
    otherLane?: boolean;
    text?: string;
    otherText?: string;
    extraLines?: FixtureLine[];
    missingModel?: boolean;
    missingModelId?: boolean;
    missingMovement?: boolean;
    timeoutMs?: number;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-cloud-'));
  const path = join(dir, 'synthetic.db');
  let db = openDb(path);
  let at = Date.parse('2026-09-01T10:00:00.000Z');
  const now = () => new Date(at);
  const sleeps: number[] = [];
  const logs: unknown[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    at += ms;
  };
  const config = loadConfig({
    KANBAN_SECRET_KEY: Buffer.alloc(32, 13).toString('base64'),
    CONNECTORS: 'fixture',
    MODEL_PROVIDER: 'openai',
    OPENAI_MODEL: options.missingModelId ? undefined : 'synthetic-verbatim-model',
    OPENAI_API_KEY: options.missingModel ? undefined : 'synthetic-openai-secret',
    OPENAI_TIMEOUT_MS: String(options.timeoutMs ?? 30000),
    JEV_TIMEOUT_MS: String(options.timeoutMs ?? 10000),
    OPENAI_MAX_ATTEMPTS: String(options.attempts ?? 2),
    MOVEMENT_PROVIDER: 'jev',
    JEV_API_KEY: options.missingMovement && !options.gateway ? undefined : 'synthetic-jev-secret',
    JEV_ENDPOINT: options.gateway ? 'https://ai-gateway.vercel.sh/typesafe/v1/systemone' : undefined,
    AI_GATEWAY_API_KEY: options.missingMovement ? undefined : 'synthetic-gateway-secret',
    JEV_MAX_ATTEMPTS: String(options.movementAttempts ?? 1),
  });
  const fixture = createFixtureConnector({
    lines: [...recording(options.text, options.otherText), ...(options.extraLines ?? [])],
  });
  const ctx: Ctx = { db, actor: { kind: 'system' }, canReadText: true, now };
  const id = addTeammate(ctx, { username: 'alice', displayName: 'Alice', password: 'synthetic-password' });
  ctx.actor = { kind: 'teammate', id };
  if (options.threshold !== undefined) setSetting(ctx, 'review_threshold', options.threshold);
  const lane = createLane(ctx, {
    name: 'Sales',
    sop: 'Customer integration work',
    stages: [
      { name: 'New', criteria: '' },
      { name: 'Done', criteria: 'Customer confirms integration delivered' },
    ],
  });
  const other = options.otherLane
    ? createLane(ctx, {
        name: 'Finance',
        sop: 'Invoices and payments',
        stages: [
          { name: 'Received', criteria: '' },
          { name: 'Paid', criteria: 'Payment confirmed' },
        ],
      })
    : null;
  const calls: { url: string; input: DecideInput | WireRequest; init: RequestInit }[] = [];
  const handlers = {
    general: async (input: DecideInput, _request: OpenAIResponseRequest): Promise<Response> =>
      jsonResponse(completed(decision(input))),
    movement: async (body: WireRequest): Promise<Response> => jsonResponse(jevAnswer(body)),
    normalized: (result: MovementResult): MovementResult => result,
  };
  const send = async (url: string, init: RequestInit): Promise<Response> => {
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.ok(init.signal);
    if (url === 'https://api.openai.com/v1/responses') {
      const request = OpenAIResponseRequestSchema.parse(JSON.parse(String(init.body)));
      const user = request.input.find((i) => i.role === 'user')?.content;
      assert.ok(user);
      const input = DecideInputSchema.parse(JSON.parse(user.slice(user.indexOf('\n') + 1)));
      calls.push({ url, input, init });
      return handlers.general(input, request);
    }
    assert.equal(
      url,
      options.gateway ? 'https://ai-gateway.vercel.sh/typesafe/v1/systemone' : 'https://api.typesafe.ai/v1/systemone',
    );
    const body = JSON.parse(String(init.body)) as WireRequest;
    calls.push({ url, input: body, init });
    return handlers.movement(body);
  };
  const build = async () => {
    const movement = await createMovementProvider(config.movement, {
      db,
      now,
      sleep,
      oplog() {},
      http: createMovementHttpPort(send),
    });
    return createApp({
      db,
      config,
      model: await createModel(config.model, { db, oplog() {}, openai: createOpenAIResponsesPort(config.model, send) }),
      movement: {
        status: movement.status,
        async decide(r, signal) {
          return handlers.normalized(await movement.decide(r, signal));
        },
      },
      connectors: [fixture.factory],
      now,
      sleep,
      oplog(_level, event, fields) {
        logs.push({ event, fields });
      },
    });
  };
  let app = await build();
  let closed = false;
  const cookie = `kanban_session=${signIn(db, 'alice', 'synthetic-password', now()).token}`;
  const h = {
    get db() {
      return db;
    },
    get app() {
      return app;
    },
    get ctx() {
      return ctx;
    },
    dir,
    path,
    config,
    handlers,
    calls,
    sleeps,
    logs,
    lane,
    other,
    cookie,
    advance(ms: number) {
      at += ms;
    },
    async deliver(mark: string) {
      await fixture.control.advanceTo(mark);
      await app.host.settle();
    },
    async get(path: string) {
      return app.fetch(new Request(`${config.origin}${path}`, { headers: { Cookie: cookie } }));
    },
    async post(path: string, form: Record<string, string> = {}) {
      return app.fetch(
        new Request(`${config.origin}${path}`, {
          method: 'POST',
          headers: { Cookie: cookie, Origin: config.origin },
          body: new URLSearchParams(form),
        }),
      );
    },
    async restart() {
      await app.stop();
      db.close();
      db = openDb(path);
      ctx.db = db;
      app = await build();
      await app.host.startAll();
    },
    async close() {
      if (closed) return;
      closed = true;
      await app.stop();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  t.after(h.close);
  try {
    await fixture.control.advanceTo('setup');
    const login = await app.host.beginLogin(ctx, 'fixture', { acknowledgedNoticeVersion: null });
    await app.host.continueLogin(ctx, login.accountId, { account: 'alice' });
    await app.host.startAll();
    await app.host.listChats(ctx, login.accountId);
    app.host.includeChat(ctx, login.accountId, 'work', { company: null, agreedWordingVersion: 1 });
    await app.host.settle();
    return h;
  } catch (error) {
    await h.close();
    throw error;
  }
}
