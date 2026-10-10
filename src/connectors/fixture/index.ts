import { readFileSync } from 'node:fs';
import type {
  ChatListEntry,
  ChatRef,
  ConnectorContext,
  ConnectorFactory,
  FixtureControl,
  FixtureLine,
  MessageRecord,
  ParticipantRef,
} from '../../contracts/index.ts';
import { AppError, FixtureLineSchema, HistoryRequestSchema } from '../../contracts/index.ts';
import { createDelivery } from '../delivery.ts';
import { historyToken, readHistoryToken } from '../history-token.ts';

export type { FixtureControl, FixtureLine } from '../../contracts/index.ts';

type ErrorPlan = { afterPages: number; remaining: number };
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
    const parsed = FixtureLineSchema.safeParse(value);
    if (!parsed.success) throw new AppError('invalid', 'Invalid fixture line');
    return parsed.data;
  });
  if (lines.some((line, i) => line.t === 'config' && i !== 0))
    throw new AppError('invalid', 'Fixture config must be first');
  const pageSize = lines[0]?.t === 'config' ? lines[0].pageSize : 100;
  if (pageSize > 100) throw new AppError('invalid', 'Fixture page size exceeds 100');
  const selves = new Map<string, ParticipantRef>();
  const chats = new Map<string, Map<string, ChatRef>>();
  const history = new Map<string, Map<string, MessageRecord[]>>();
  const errors = new Map<string, Map<string, ErrorPlan>>();
  const latest = new Map<string, Map<string, MessageRecord>>();
  const started = new Map<object, { account: string; delivery: ReturnType<typeof createDelivery> }>();
  let position = 0;
  let advancing = false;
  for (const line of lines)
    if (line.t === 'account') {
      if (selves.has(line.account)) throw new AppError('invalid', 'Duplicate fixture account');
      selves.set(line.account, line.self);
    }
  function messages(account: string, key: string): MessageRecord[] {
    let byChat = history.get(account);
    if (!byChat) {
      byChat = new Map();
      history.set(account, byChat);
    }
    let result = byChat.get(key);
    if (!result) {
      result = [];
      byChat.set(key, result);
    }
    return result;
  }
  async function deliver(account: string, event: Parameters<ReturnType<typeof createDelivery>['emit']>[0]) {
    for (const entry of [...started.values()]) if (entry.account === account) await entry.delivery.emit(event);
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
            map.set(line.chat.key, structuredClone(line.chat));
          } else if (line.t === 'message' || line.t === 'edit') {
            const chat = chats.get(line.account)?.get(line.chatKey);
            if (!chat) throw new AppError('invalid', 'Fixture message has no chat');
            if (line.t === 'message') {
              let map = latest.get(line.account);
              if (!map) {
                map = new Map();
                latest.set(line.account, map);
              }
              const previous = map.get(line.chatKey);
              if (!previous || line.message.cursor >= previous.cursor)
                map.set(line.chatKey, structuredClone(line.message));
            }
            const records = messages(line.account, line.chatKey);
            const original = records.find((m) => m.nativeId === line.message.nativeId);
            const message = structuredClone(line.message);
            if (original) {
              message.key = original.key;
              if (line.t === 'edit') records[records.indexOf(original)] = message;
            } else records.push(message);
            if (line.t === 'edit' || line.delivery === 'live')
              await deliver(line.account, { type: line.t, chat: structuredClone(chat), message });
          } else if (line.t === 'delete') {
            for (const records of history.get(line.account)?.values() ?? []) {
              for (let i = records.length - 1; i >= 0; i--)
                if (line.nativeIds.includes(records[i]?.nativeId ?? '')) records.splice(i, 1);
            }
            await deliver(line.account, { type: 'delete', nativeIds: [...line.nativeIds], deletedAt: line.deletedAt });
          } else if (line.t === 'history_error') {
            let map = errors.get(line.account);
            if (!map) {
              map = new Map();
              errors.set(line.account, map);
            }
            map.set(line.chatKey, { afterPages: line.afterPages, remaining: line.times ?? Number.POSITIVE_INFINITY });
          }
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
    create(ctx: ConnectorContext) {
      let account: string | null = ctx.session;
      const identity = {};
      const delivery = createDelivery();
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
          const self = input.account && Object.keys(input).length === 1 ? selves.get(input.account) : undefined;
          if (!self) return { kind: 'failed', message: 'Unknown fixture account', retryable: true };
          account = input.account ?? null;
          ctx.saveSession(account);
          return { kind: 'done', self: structuredClone(self) };
        },
        async start(sink) {
          const name = ready();
          delivery.start(sink);
          started.set(identity, { account: name, delivery });
          await delivery.emit({ type: 'status', state: 'connected' });
        },
        async stop() {
          delivery.stop();
          started.delete(identity);
          if (account !== null) ctx.saveSession(account);
        },
        async logout() {
          delivery.stop();
          started.delete(identity);
          account = null;
          ctx.saveSession(null);
        },
        async listChats() {
          const name = ready();
          control.calls.push({ account: name, op: 'listChats', chatKey: null, atMs: ctx.now().getTime() });
          return Array.from(chats.get(name)?.values() ?? [], (chat): ChatListEntry => {
            const newest = latest.get(name)?.get(chat.key);
            return {
              chat: structuredClone(chat),
              latestAt: newest?.sentAt ?? null,
              latestCursor: newest?.cursor ?? null,
            };
          });
        },
        async *fetchHistory(req) {
          if (!HistoryRequestSchema.safeParse(req).success) throw new AppError('invalid', 'Invalid history request');
          const name = ready();
          if (!chats.get(name)?.has(req.chat.key)) throw new AppError('not_found', 'Fixture chat not found');
          const resume = readHistoryToken(name, req);
          const candidates = messages(name, req.chat.key)
            .filter(
              (m) =>
                (req.after === null || m.cursor > req.after) &&
                (req.since === null || m.sentAt >= req.since) &&
                (resume === null || m.cursor < resume.before),
            )
            .sort((a, b) => b.cursor.localeCompare(a.cursor));
          const remaining = req.limit === null ? candidates.length : Math.max(0, req.limit - (resume?.returned ?? 0));
          const records = candidates.slice(0, remaining);
          const plan = errors.get(name)?.get(req.chat.key);
          const failAfter = plan && plan.remaining > 0 ? plan.afterPages : null;
          if (plan && plan.remaining > 0) plan.remaining--;
          let pages = 0;
          let returned = resume?.returned ?? 0;
          for (let offset = 0; offset < Math.max(records.length, 1); offset += pageSize) {
            if (failAfter !== null && pages === failAfter) throw new AppError('invalid', 'Synthetic history failure');
            control.calls.push({ account: name, op: 'fetchHistory', chatKey: req.chat.key, atMs: ctx.now().getTime() });
            const page = records.slice(offset, offset + pageSize);
            returned += page.length;
            const last = page.at(-1);
            pages++;
            yield {
              messages: structuredClone(page),
              resume:
                offset + pageSize < records.length && last ? historyToken(name, req, last.cursor, returned) : null,
            };
          }
          if (failAfter !== null && pages === failAfter) throw new AppError('invalid', 'Synthetic history failure');
        },
      };
    },
  };
  return { factory, control };
}
