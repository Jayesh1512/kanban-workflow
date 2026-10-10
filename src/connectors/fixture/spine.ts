import { readFileSync } from 'node:fs';
import type {
  ChatListEntry,
  ChatRef,
  ConnectorContext,
  ConnectorFactory,
  EventSink,
  FixtureControl,
  FixtureLine,
  MessageRecord,
  ParticipantRef,
} from '../../contracts/index.ts';
import { AppError, FixtureLineSchema, HistoryRequestSchema } from '../../contracts/index.ts';

export function createFixtureConnector(source: { path: string } | { lines: FixtureLine[] }): {
  factory: ConnectorFactory;
  control: FixtureControl;
} {
  const raw =
    'lines' in source
      ? source.lines
      : readFileSync(source.path, 'utf8')
          .split('\n')
          .filter((s) => s.trim())
          .map((s) => JSON.parse(s) as unknown);
  const lines = raw.map((value) => {
    const p = FixtureLineSchema.safeParse(value);
    if (!p.success) throw new AppError('invalid', 'Invalid fixture line');
    return p.data;
  });
  const selves = new Map<string, ParticipantRef>();
  const chats = new Map<string, Map<string, ChatRef>>();
  const history = new Map<string, Map<string, MessageRecord[]>>();
  const started = new Map<ConnectorContext, { account: string; sink: EventSink }>();
  let position = 0;
  let advancing = false;
  const pageSize = lines.find((l) => l.t === 'config')?.pageSize ?? 100;
  for (const line of lines)
    if (line.t === 'account') {
      if (selves.has(line.account)) throw new AppError('invalid', 'Duplicate fixture account');
      selves.set(line.account, line.self);
    }
  const control: FixtureControl = {
    calls: [],
    async advanceTo(mark) {
      if (advancing) throw new AppError('conflict', 'Fixture advance already active');
      if (mark !== 'end' && !lines.slice(position).some((l) => l.t === 'mark' && l.name === mark))
        throw new AppError('invalid', 'Unknown or passed fixture mark');
      advancing = true;
      try {
        while (position < lines.length) {
          const line = lines[position++];
          if (!line) break;
          if (line.t === 'mark') {
            if (line.name === mark) break;
            continue;
          }
          if (line.t === 'chat') {
            let map = chats.get(line.account);
            if (!map) {
              map = new Map();
              chats.set(line.account, map);
            }
            map.set(line.chat.key, line.chat);
          }
          if (line.t === 'message') {
            let map = history.get(line.account);
            if (!map) {
              map = new Map();
              history.set(line.account, map);
            }
            const messages = map.get(line.chatKey) ?? [];
            messages.push(line.message);
            map.set(line.chatKey, messages);
            if (line.delivery === 'live') {
              const chat = chats.get(line.account)?.get(line.chatKey);
              if (!chat) throw new AppError('invalid', 'Fixture message has no chat');
              for (const { account, sink } of started.values())
                if (account === line.account) await sink.emit({ type: 'message', chat, message: line.message });
            }
          }
          if (line.t === 'edit' || line.t === 'delete' || line.t === 'history_error')
            throw new AppError('invalid', `not built: ${line.t}`);
        }
      } finally {
        advancing = false;
      }
    },
  };
  const factory: ConnectorFactory = {
    channel: 'fixture',
    label: 'Synthetic fixture',
    capabilities: { history: true, edits: true, deletions: true },
    pace: { minRequestIntervalMs: 0, pageSize },
    loginNotice: () => null,
    create(ctx) {
      let account: string | null = ctx.session;
      function ready(): string {
        if (account === null || !selves.has(account)) throw new AppError('unauthenticated', 'Fixture login required');
        return account;
      }
      return {
        async login(input) {
          if (input === null)
            return {
              kind: 'need_input',
              fields: [{ name: 'account', label: 'Account', secret: false }],
              hint: 'Choose a synthetic account',
            };
          if (Object.keys(input).length !== 1 || !input.account || !selves.has(input.account))
            return { kind: 'failed', message: 'Unknown fixture account', retryable: true };
          account = input.account;
          ctx.saveSession(account);
          return { kind: 'done', self: selves.get(account) as ParticipantRef };
        },
        async start(sink) {
          const name = ready();
          started.set(ctx, { account: name, sink });
          await sink.emit({ type: 'status', state: 'connected' });
        },
        async stop() {
          started.delete(ctx);
        },
        async logout() {
          throw new AppError('invalid', 'not built: logout');
        },
        async listChats() {
          const name = ready();
          control.calls.push({ account: name, op: 'listChats', chatKey: null, atMs: ctx.now().getTime() });
          return Array.from(chats.get(name)?.values() ?? [], (chat): ChatListEntry => {
            const newest = (history.get(name)?.get(chat.key) ?? [])
              .slice()
              .sort((a, b) => b.sentAt.localeCompare(a.sentAt))[0];
            return { chat, latestAt: newest?.sentAt ?? null, latestCursor: newest?.cursor ?? null };
          });
        },
        async *fetchHistory(req) {
          if (!HistoryRequestSchema.safeParse(req).success) throw new AppError('invalid', 'Invalid history request');
          if (req.after !== null || req.resume !== null || req.since === null || req.limit === null || req.limit > 200)
            throw new AppError('invalid', 'not built: fetchHistory');
          const name = ready();
          control.calls.push({ account: name, op: 'fetchHistory', chatKey: req.chat.key, atMs: ctx.now().getTime() });
          if (!chats.get(name)?.has(req.chat.key)) throw new AppError('not_found', 'Fixture chat not found');
          const messages = (history.get(name)?.get(req.chat.key) ?? [])
            .filter((m) => m.sentAt >= (req.since as string))
            .sort((a, b) => b.sentAt.localeCompare(a.sentAt) || b.cursor.localeCompare(a.cursor))
            .slice(0, req.limit);
          if (messages.length === 0) {
            yield { messages: [], resume: null };
            return;
          }
          for (let offset = 0; offset < messages.length; offset += pageSize)
            yield {
              messages: messages.slice(offset, offset + pageSize),
              resume: offset + pageSize < messages.length ? String(offset + pageSize) : null,
            };
        },
      };
    },
  };
  return { factory, control };
}
