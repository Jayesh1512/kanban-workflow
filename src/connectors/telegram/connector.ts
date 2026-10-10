import type {
  Connector,
  ConnectorContext,
  ConnectorFactory,
  TelegramApi,
  TgMessage,
  TgPeer,
  TgUser,
} from '../../contracts/index.ts';
import { AppError, HistoryRequestSchema, TgFloodWait } from '../../contracts/index.ts';
import { createDelivery } from '../delivery.ts';
import { historyToken, readHistoryToken } from '../history-token.ts';
import { chatRef, createDecoder, nativeId, participant } from './decode.ts';

export function telegramLoginNotice(config: Record<string, string>) {
  return {
    version: 1,
    text: `The stored session gives full control of your account; Telegram offers no read-only credential. Telegram puts unofficial-client accounts under observation and may restrict them; the rate for read-only use is unknown. The application is registered under ${config.APP_OWNER ?? '(registration owner not configured)'}'s phone number; Telegram notifies that account and its remedy ends access for every teammate.`,
  };
}
/** Explicit port injection; constructing a factory never connects or reads ambient configuration. */
export function createTelegramFactory(createApi: (ctx: ConnectorContext) => TelegramApi): ConnectorFactory {
  return {
    channel: 'telegram',
    label: 'Telegram',
    capabilities: { history: true, edits: true, deletions: true },
    pace: { minRequestIntervalMs: 3000, pageSize: 100 },
    loginNotice: telegramLoginNotice,
    create: (ctx) => createTelegramConnector(ctx, createApi(ctx)),
  };
}
export function createTelegramConnector(ctx: ConnectorContext, api: TelegramApi): Connector {
  let session = ctx.session;
  let self: TgUser | null = null;
  let phone: string | null = null;
  let hash: string | null = null;
  let loginStage: 'phone' | 'code' | 'password' = 'phone';
  let active = false;
  let epoch = 0;
  let lastRequest: number | null = null;
  const delivery = createDelivery();
  const decode = createDecoder();
  const titles = new Map<string, string>();
  async function ready() {
    if (session === null) throw new AppError('unauthenticated', 'Login required');
    if (self === null) {
      await api.importSession(session);
      self = await api.getMe();
    }
    return self;
  }
  async function save() {
    session = await api.exportSession();
    ctx.saveSession(session);
  }
  async function request<T>(fn: () => Promise<T>, pace: { interval: number }): Promise<T> {
    for (;;) {
      if (lastRequest !== null) {
        const wait = lastRequest + pace.interval - ctx.now().getTime();
        if (wait > 0) await ctx.sleep(wait);
      }
      lastRequest = ctx.now().getTime();
      try {
        return await fn();
      } catch (error) {
        if (!(error instanceof TgFloodWait)) throw error;
        if (!Number.isFinite(error.seconds) || error.seconds < 0 || error.seconds > 600)
          throw new AppError('invalid', 'History wait exceeds retry boundary');
        await ctx.sleep(error.seconds * 1000);
        pace.interval *= 2;
      }
    }
  }
  function need(name: 'phone' | 'code' | 'password') {
    return {
      kind: 'need_input' as const,
      fields: [
        {
          name,
          label: name === 'phone' ? 'Phone number' : name === 'code' ? 'Login code' : 'Account password',
          secret: name !== 'phone',
        },
      ],
      hint: 'Enter the requested account login field',
    };
  }
  async function message(m: TgMessage, type: 'message' | 'edit', generation: number) {
    if (!active || generation !== epoch || !self) return;
    const record = decode(m);
    if (record)
      await delivery.emit({
        type,
        chat: chatRef(m.peer, self.id, titles.get(`${m.peer.type}:${m.peer.id}`) ?? ''),
        message: record,
      });
  }
  return {
    async login(input) {
      if (input === null) {
        if (session !== null) return { kind: 'done', self: participant(await ready()) };
        loginStage = 'phone';
        phone = null;
        hash = null;
        return need('phone');
      }
      if (Object.keys(input).length !== 1 || !input[loginStage])
        return { kind: 'failed', message: 'Requested login field is required', retryable: true };
      try {
        if (loginStage === 'phone') {
          phone = input.phone ?? null;
          const sent = await api.sendCode(phone as string);
          hash = sent.phoneCodeHash;
          loginStage = 'code';
          return need('code');
        }
        const result =
          loginStage === 'password'
            ? await api.checkPassword(input.password as string)
            : await api.signIn({ phone: phone as string, phoneCodeHash: hash as string, code: input.code as string });
        if (result === 'password_needed') {
          loginStage = 'password';
          return need('password');
        }
        self = result;
        await save();
        phone = null;
        hash = null;
        return { kind: 'done', self: participant(result) };
      } catch {
        ctx.log('warn', 'connector.login_failed', { accountId: ctx.accountId });
        return { kind: 'failed', message: 'Login failed; retry the requested field', retryable: true };
      }
    },
    async start(sink) {
      const generation = ++epoch;
      active = false;
      await ready();
      if (generation !== epoch) return;
      // The persisted opaque session is reimported on every start, including a restart of this instance.
      await api.importSession(session as string);
      if (generation !== epoch) return;
      delivery.start(sink);
      active = true;
      try {
        await api.startUpdates({
          onNew: (m) => message(m, 'message', generation),
          onEdit: (m) => message(m, 'edit', generation),
          async onDelete(d) {
            if (!active || generation !== epoch) return;
            await delivery.emit({
              type: 'delete',
              nativeIds: d.ids.map((id) =>
                nativeId({ type: d.channelId === null ? 'user' : 'channel', id: d.channelId ?? 0 }, id),
              ),
              deletedAt: ctx.now().toISOString(),
            });
          },
          onState(state) {
            if (!active || generation !== epoch) return;
            void delivery.emit({ type: 'status', state }).catch(() => {
              ctx.log('warn', 'connector.sink_failed', { accountId: ctx.accountId });
            });
          },
        });
      } catch (error) {
        if (generation === epoch) {
          active = false;
          epoch++;
          delivery.stop();
        }
        throw error;
      }
    },
    async stop() {
      active = false;
      epoch++;
      delivery.stop();
      await api.destroy();
      if (session !== null && self !== null) await save();
    },
    async logout() {
      active = false;
      epoch++;
      delivery.stop();
      try {
        await api.logOut();
      } finally {
        try {
          await api.destroy();
        } finally {
          session = null;
          self = null;
          ctx.saveSession(null);
        }
      }
    },
    async listChats() {
      const me = await ready();
      const pace = { interval: 3000 };
      const result = [];
      let offset: string | null = null;
      const seen = new Set<string>();
      do {
        const page = await request(() => api.dialogs({ offset, limit: 100 }), pace);
        for (const dialog of page.dialogs) {
          const chat = chatRef(dialog.peer, me.id, dialog.title);
          titles.set(chat.nativeId, chat.title);
          result.push({
            chat,
            latestAt: dialog.lastMessageDate === null ? null : new Date(dialog.lastMessageDate * 1000).toISOString(),
            latestCursor: dialog.lastMessageId === null ? null : String(dialog.lastMessageId),
          });
        }
        offset = page.next;
        if (offset !== null && seen.has(offset)) throw new AppError('invalid', 'Repeated dialog cursor');
        if (offset !== null) seen.add(offset);
      } while (offset !== null);
      return result;
    },
    async *fetchHistory(req) {
      if (!HistoryRequestSchema.safeParse(req).success) throw new AppError('invalid', 'Invalid history request');
      const me = await ready();
      const match = /^(user|group|supergroup|channel):(\d+)$/.exec(req.chat.nativeId);
      if (!match) throw new AppError('invalid', 'Invalid chat handle');
      const peer: TgPeer = { type: match[1] as TgPeer['type'], id: Number(match[2]) };
      if (chatRef(peer, me.id, '').key !== req.chat.key)
        throw new AppError('invalid', 'Chat key does not match handle');
      const token = readHistoryToken(String(ctx.accountId), req);
      if ((req.after !== null && !/^\d+$/.test(req.after)) || (token && !/^\d+$/.test(token.before)))
        throw new AppError('invalid', 'Invalid history cursor');
      const minId = Number(req.after ?? 0);
      let maxId = Number(token?.before ?? 0);
      let returned = token?.returned ?? 0;
      const pace = { interval: 3000 };
      while (req.limit === null || returned < req.limit) {
        const limit = Math.min(100, req.limit === null ? 100 : req.limit - returned);
        const page = await request(() => api.history(peer, { minId, maxId, limit }), pace);
        const last = page.at(-1);
        if (last && (last.id <= minId || (maxId !== 0 && last.id >= maxId)))
          throw new AppError('invalid', 'History cursor made no progress');
        const messages = [];
        let reachedSince = false;
        for (const m of page) {
          if (req.since !== null && new Date(m.date * 1000).toISOString() < req.since) {
            reachedSince = true;
            break;
          }
          const record = decode(m);
          if (record) messages.push(record);
        }
        returned += messages.length;
        const finished = page.length < limit || reachedSince || (req.limit !== null && returned >= req.limit);
        yield {
          messages,
          resume: !finished && last ? historyToken(String(ctx.accountId), req, String(last.id), returned) : null,
        };
        if (finished || !last) return;
        maxId = last.id;
      }
      if (req.limit === 0) yield { messages: [], resume: null };
    },
  };
}
