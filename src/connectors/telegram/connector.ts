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
import { createApiLifecycle } from './api-lifecycle.ts';
import { telegramApplicationProfile } from './application-profile.ts';
import { chatRef, nativeId, participant } from './decode.ts';
import { createSessionState } from './session-state.ts';
import { createTerminalLogout } from './terminal-logout.ts';

export function telegramLoginNotice(config: Record<string, string>) {
  if (telegramApplicationProfile(config) === 'tdl')
    return {
      version: 2,
      text: 'The stored session gives full control of your account; Telegram offers no read-only credential. This connector performs read-only chat operations, but Telegram puts unofficial-client accounts under observation and may restrict them; the rate for read-only use is unknown. You selected the public AppBuiltin application profile published by iyear/tdl v0.20.4 and attributed there to iyear. The actual application registrant and Telegram notification/remedy arrangements are unverified. Shared application disablement may end access for every user of this profile. No personal application registration is requested in this mode. Source publication does not establish Telegram permission or supplier support.',
    };
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
  let self: TgUser | null = null;
  let phone: string | null = null;
  let hash: string | null = null;
  let loginStage: 'phone' | 'code' | 'password' = 'phone';
  let active = false;
  let epoch = 0;
  let lastRequest: number | null = null;
  const delivery = createDelivery();
  const lifecycle = createApiLifecycle(api);
  const sessions = createSessionState(ctx, api, async () => {
    active = false;
    const failedGeneration = ++epoch;
    // A slow/broken host observer cannot delay abort and bounded SDK cleanup.
    void delivery.emit({ type: 'status', state: 'disconnected' }).catch(() => {});
    try {
      await lifecycle.destroy();
    } catch {
      ctx.log('warn', 'connector.cleanup_failed', { accountId: ctx.accountId });
    } finally {
      if (failedGeneration === epoch) delivery.stop();
    }
  });
  const terminal = createTerminalLogout(
    ctx,
    sessions,
    lifecycle,
    () => api.logOut(),
    () => {
      active = false;
      epoch++;
      delivery.stop();
    },
    () => {
      self = null;
      phone = null;
      hash = null;
      titles.clear();
    },
  );
  const titles = new Map<string, string>();
  async function ready(valid = () => true) {
    terminal.assertOpen();
    const health = sessions.guard();
    sessions.healthy();
    const session = sessions.opaque();
    if (session === null) throw new AppError('unauthenticated', 'Login required');
    if (self === null || !lifecycle.currentAuth()) {
      await lifecycle.importSession(session);
      health();
      sessions.healthy();
      if (!valid()) throw new AppError('invalid', 'Connector stopped');
      const restored = await api.getMe();
      health();
      sessions.healthy();
      if (!valid()) throw new AppError('invalid', 'Connector stopped');
      self = restored;
    }
    return self;
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
    const [record] = await sessions.learn([m], () => active && generation === epoch);
    if (!active || generation !== epoch) return;
    if (record) {
      try {
        await delivery.emit({
          type,
          chat: chatRef(m.peer, self.id, titles.get(`${m.peer.type}:${m.peer.id}`) ?? ''),
          message: record,
        });
      } catch (error) {
        if (generation !== epoch) throw error;
        active = false;
        epoch++;
        delivery.stop();
        try {
          await lifecycle.destroy();
        } catch {
          ctx.log('warn', 'connector.cleanup_failed', { accountId: ctx.accountId });
        }
        throw error;
      }
    }
  }
  return {
    async login(input) {
      terminal.assertOpen();
      const generation = epoch;
      const health = sessions.guard();
      sessions.restore();
      sessions.healthy();
      if (input === null) {
        if (sessions.opaque() !== null) {
          try {
            const result = await ready(() => generation === epoch);
            await sessions.save(() => generation === epoch);
            sessions.healthy();
            if (generation !== epoch) throw new AppError('invalid', 'Connector stopped');
            return { kind: 'done', self: participant(result) };
          } catch (error) {
            health();
            sessions.healthy();
            if (generation !== epoch) throw new AppError('invalid', 'Connector stopped');
            throw error;
          }
        }
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
          if (generation !== epoch) throw new AppError('invalid', 'Connector stopped');
          hash = sent.phoneCodeHash;
          loginStage = 'code';
          return need('code');
        }
        const result =
          loginStage === 'password'
            ? await api.checkPassword(input.password as string)
            : await api.signIn({ phone: phone as string, phoneCodeHash: hash as string, code: input.code as string });
        if (generation !== epoch) throw new AppError('invalid', 'Connector stopped');
        if (result === 'password_needed') {
          loginStage = 'password';
          return need('password');
        }
        if (generation !== epoch) throw new AppError('invalid', 'Connector stopped');
        lifecycle.authorized();
        self = result;
        await sessions.save(() => generation === epoch);
        sessions.healthy();
        if (generation !== epoch) throw new AppError('invalid', 'Connector stopped');
        phone = null;
        hash = null;
        return { kind: 'done', self: participant(result) };
      } catch (error) {
        health();
        if (sessions.isFailed()) throw error;
        ctx.log('warn', 'connector.login_failed', { accountId: ctx.accountId });
        return { kind: 'failed', message: 'Login failed; retry the requested field', retryable: true };
      }
    },
    async start(sink) {
      terminal.assertOpen();
      const generation = ++epoch;
      const health = sessions.guard();
      active = false;
      const cancelled = () => {
        // Fault cleanup also invalidates epoch; it must never masquerade as caller cancellation.
        health();
        sessions.healthy();
        return generation !== epoch;
      };
      try {
        await ready(() => generation === epoch);
      } catch (error) {
        if (cancelled()) return;
        throw error;
      }
      if (cancelled()) return;
      // Only the opaque inner SDK session is reimported on every start, including a restart of this instance.
      try {
        await lifecycle.importSession(sessions.opaque() as string);
      } catch (error) {
        if (cancelled()) return;
        throw error;
      }
      if (cancelled()) return;
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
            if (state === 'auth_lost') lifecycle.lost();
            void delivery.emit({ type: 'status', state }).catch(() => {
              if (active && generation === epoch) {
                active = false;
                epoch++;
                delivery.stop();
                void lifecycle
                  .destroy()
                  .catch(() => ctx.log('warn', 'connector.cleanup_failed', { accountId: ctx.accountId }));
              }
              ctx.log('warn', 'connector.sink_failed', { accountId: ctx.accountId });
            });
          },
        });
        cancelled(); // A canceled adapter startup can resolve normally after fault-triggered destroy.
      } catch (error) {
        if (cancelled()) return;
        if (generation === epoch) {
          active = false;
          epoch++;
          delivery.stop();
        }
        throw error;
      }
    },
    async stop() {
      if (terminal.active()) return terminal.stop() as Promise<void>;
      const health = sessions.guard();
      active = false;
      const generation = ++epoch;
      sessions.invalidate();
      delivery.stop();
      try {
        await lifecycle.destroy();
        health();
        if (generation !== epoch) {
          sessions.healthy();
          return;
        }
        if (sessions.opaque() !== null && self !== null) await sessions.save(() => generation === epoch);
      } finally {
        health(); // An admitted save may throw AFTER synchronously invoking this stop.
      }
    },
    logout() {
      return terminal.logout();
    },
    async listChats() {
      const generation = epoch;
      const me = await ready(() => generation === epoch);
      const pace = { interval: 3000 };
      const result = [];
      let offset: string | null = null;
      const seen = new Set<string>();
      do {
        const page = await request(() => {
          if (generation !== epoch) throw new AppError('invalid', 'Connector stopped');
          return api.dialogs({ offset, limit: 100 });
        }, pace);
        if (generation !== epoch) throw new AppError('invalid', 'Connector stopped');
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
      const generation = epoch;
      const me = await ready(() => generation === epoch);
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
        const page = await request(() => {
          if (generation !== epoch) throw new AppError('invalid', 'Connector stopped');
          return api.history(peer, { minId, maxId, limit });
        }, pace);
        if (generation !== epoch) throw new AppError('invalid', 'Connector stopped');
        const last = page.at(-1);
        if (last && (last.id <= minId || (maxId !== 0 && last.id >= maxId)))
          throw new AppError('invalid', 'History cursor made no progress');
        const staged: TgMessage[] = [];
        let reachedSince = false;
        for (const m of page) {
          if (req.since !== null && new Date(m.date * 1000).toISOString() < req.since) {
            reachedSince = true;
            break;
          }
          staged.push(m);
        }
        const messages = await sessions.learn(staged, () => generation === epoch);
        if (generation !== epoch) throw new AppError('invalid', 'Connector stopped');
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
