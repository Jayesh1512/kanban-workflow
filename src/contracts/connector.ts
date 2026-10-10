import type { Id, IsoTime, OpLog } from './index.ts';

export interface ConnectorFactory {
  readonly channel: string;
  readonly label: string;
  readonly capabilities: { history: boolean; edits: boolean; deletions: boolean };

  readonly pace: { minRequestIntervalMs: number; pageSize: number };

  loginNotice(config: Record<string, string>): { version: number; text: string } | null;
  create(ctx: ConnectorContext): Connector;
}

export interface ConnectorContext {
  accountId: Id;
  session: string | null;
  config: Record<string, string>;
  saveSession(session: string | null): void;
  now(): Date;
  sleep(ms: number): Promise<void>;
  log: OpLog;
}

export interface Connector {
  login(input: Record<string, string> | null): Promise<LoginStep>;

  start(sink: EventSink): Promise<void>;

  stop(): Promise<void>;

  logout(): Promise<void>;

  listChats(): Promise<ChatListEntry[]>;

  fetchHistory(req: HistoryRequest): AsyncIterable<HistoryPage>;
}

export type LoginStep =
  | { kind: 'need_input'; fields: { name: string; label: string; secret: boolean }[]; hint: string }
  | { kind: 'done'; self: ParticipantRef }
  | { kind: 'failed'; message: string; retryable: boolean };

export interface EventSink {
  emit(event: ConnectorEvent): Promise<void>;
}

export type ConnectorEvent =
  | { type: 'message'; chat: ChatRef; message: MessageRecord }
  | { type: 'edit'; chat: ChatRef; message: MessageRecord }
  | { type: 'delete'; nativeIds: string[]; deletedAt: IsoTime }
  | { type: 'status'; state: 'connected' | 'disconnected' | 'auth_lost' };

export interface ChatRef {
  key: string;
  nativeId: string;
  kind: 'direct' | 'group' | 'broadcast';
  title: string;
}

export interface ChatListEntry {
  chat: ChatRef;
  latestAt: IsoTime | null;
  latestCursor: string | null;
}

export interface ParticipantRef {
  userKey: string;
  displayName: string;
  handle: string | null;
}

export interface MessageRecord {
  key: string;
  nativeId: string;
  cursor: string;
  sender: ParticipantRef;
  sentAt: IsoTime;
  text: string;
  media:
    | 'photo'
    | 'video'
    | 'voice'
    | 'audio'
    | 'document'
    | 'sticker'
    | 'location'
    | 'contact'
    | 'poll'
    | 'other'
    | null;
  replyToNativeId: string | null;
  editedAt: IsoTime | null;
}

export interface HistoryRequest {
  chat: ChatRef;
  after: string | null;
  since: IsoTime | null;
  limit: number | null;
  resume: string | null;
}

export interface HistoryPage {
  messages: MessageRecord[];
  resume: string | null;
}

export type FixtureLine =
  | { t: 'config'; pageSize: number }
  | { t: 'account'; account: string; self: ParticipantRef }
  | { t: 'chat'; account: string; chat: ChatRef }
  | { t: 'message'; account: string; delivery: 'live' | 'missed' | 'history'; chatKey: string; message: MessageRecord }
  | { t: 'edit'; account: string; chatKey: string; message: MessageRecord }
  | { t: 'delete'; account: string; nativeIds: string[]; deletedAt: IsoTime }
  | { t: 'history_error'; account: string; chatKey: string; afterPages: number; times?: number }
  | { t: 'mark'; name: string };

export interface FixtureControl {
  advanceTo(mark: string): Promise<void>;

  calls: { account: string; op: string; chatKey: string | null; atMs: number }[];
}
