import type {
  AccountView,
  ChatCounts,
  ChatListing,
  ConnectorFactory,
  Ctx,
  Db,
  FixtureControl,
  Id,
  IsoTime,
  LoginStep,
  Model,
  ModelConfig,
  ModelResponseFailure,
  MovementConfig,
  MovementDecisionProvider,
  MovementProviderStatus,
  OpLog,
} from './index.ts';

export interface Host {
  listChannels(): { channel: string; label: string; loginNotice: { version: number; text: string } | null }[];
  listAccounts(ctx: Ctx): AccountView[];
  beginLogin(
    ctx: Ctx,
    channel: string,
    i: { acknowledgedNoticeVersion: number | null },
  ): Promise<{ accountId: Id; step: LoginStep }>;
  continueLogin(ctx: Ctx, accountId: Id, input: Record<string, string>): Promise<LoginStep>;
  disconnect(ctx: Ctx, accountId: Id): Promise<void>;
  listChats(ctx: Ctx, accountId: Id): Promise<ChatListing[]>;
  chatCounts(ctx: Ctx): ChatCounts;
  includeChat(
    ctx: Ctx,
    accountId: Id,
    chatKey: string,
    i: { agreedWordingVersion: number | null; company: string | null },
  ): void;
  excludeChat(ctx: Ctx, accountId: Id, chatKey: string): void;
  confirmAgreement(ctx: Ctx, accountId: Id, chatId: Id, i: { agreedWordingVersion: number }): void;
  markWithdrawn(ctx: Ctx, accountId: Id, chatId: Id): Id[];
  setIncludeAll(ctx: Ctx, accountId: Id, on: boolean): void;
  startImport(ctx: Ctx, accountId: Id, chatId: Id, i: { days: 30 | 90 | null }): void;
  startAll(): Promise<void>;
  stopAll(): Promise<void>;

  settle(): Promise<void>;
}

export interface Pipeline {
  start(): void;
  stop(): Promise<void>;
  processNext(): Promise<Id | null>;
  drain(): Promise<number>;
  status(): PipelineStatus;
}

export interface PipelineStatus {
  state: 'stopped' | 'running' | 'paused' | 'blocked';
  reason:
    | 'model_unavailable'
    | 'no_model'
    | 'model_config_missing'
    | 'model_endpoint_blocked'
    | 'model_unauthorised'
    | 'model_configuration_invalid'
    | null;
  since: IsoTime | null;
  pending: number;
  movement: MovementProviderStatus;
  modelFailure: ModelResponseFailure | 'timeout' | 'unavailable' | 'cancelled' | null;
}

export interface AppConfig {
  dataDir: string;
  secretKey: Uint8Array;
  host: string;
  port: number;
  origin: string;
  connectors: Record<string, Record<string, string>>;
  model: ModelConfig;
  movement: MovementConfig;
}

export interface AppDeps {
  db: Db;
  model: Model;
  movement: MovementDecisionProvider;
  now(): Date;
  sleep(ms: number): Promise<void>;
  connectors: ConnectorFactory[];
  config: AppConfig;
  oplog: OpLog;
}

export interface App {
  host: Host;
  pipeline: Pipeline;
  fetch(req: Request): Promise<Response>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface TestApp {
  app: App;
  db: Db;
  control: FixtureControl;
  clock: { now(): Date; advance(ms: number): void };
  ctxFor(username: string): Ctx;
  cookieFor(username: string): string;
  tokenFor(i: { name: string; scopeMessages: boolean }): string;
  get(path: string, o?: { cookie?: string; bearer?: string }): Promise<Response>;
  post(path: string, form: Record<string, string>, o?: { cookie?: string }): Promise<Response>;
  mcp(tool: string, args: unknown, bearer: string): Promise<unknown>;
  settle(): Promise<void>;
  restart(): Promise<void>;
  close(): void;
}
