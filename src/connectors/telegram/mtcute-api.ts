import type { Peer } from '@mtcute/node';
import { Dialog, Long, Message, PeersIndex, tl } from '@mtcute/node';
import { z } from 'zod';
import type { ConnectorContext, TelegramApi, TgPeer } from '../../contracts/index.ts';
import { AppError, TgFloodWait } from '../../contracts/index.ts';
import type { MtcuteClient } from './mtcute-client.ts';
import { createMtcuteClient } from './mtcute-client.ts';
import { mtMessage, mtPeer, mtUser } from './mtcute-decode.ts';

const offsetSchema = z
  .object({
    id: z.number().int().nonnegative(),
    date: z.number().int().nonnegative(),
    peer: z.string(),
    seen: z.number().int().nonnegative(),
  })
  .strict();
/** Lazy, instance-local real adapter. The optional constructor is an internal offline test seam. */
export class MtcuteApi implements TelegramApi {
  private ctx: ConnectorContext;
  private makeClient: () => MtcuteClient;
  private client: MtcuteClient | null = null;
  private session: string | null = null;
  private generation = 0;
  private detach: (() => void) | null = null;
  private queue: Promise<void> = Promise.resolve();
  private peers = new Map<string, tl.TypeInputPeer>();
  private closing: Promise<void> | null = null;
  constructor(ctx: ConnectorContext, makeClient = () => createMtcuteClient(ctx)) {
    this.ctx = ctx;
    this.makeClient = makeClient;
  }
  private getClient() {
    if (this.closing) throw new AppError('invalid', 'Connector stopping');
    this.client ??= this.makeClient();
    return this.client;
  }
  private async call<T>(run: (client: MtcuteClient) => Promise<T>): Promise<T> {
    const client = this.getClient();
    const generation = this.generation;
    try {
      const result = await run(client);
      if (generation !== this.generation) {
        await client.sdk.stopUpdatesLoop();
        throw new AppError('invalid', 'Connector stopped');
      }
      return result;
    } catch (error) {
      if (tl.RpcError.is(error)) {
        if (error.text === 'SESSION_PASSWORD_NEEDED')
          throw new AppError('unauthenticated', 'Telegram password required');
        const match = /^(?:FLOOD_WAIT|SLOWMODE_WAIT|FLOOD_TEST_PHONE_WAIT|FLOOD_PREMIUM_WAIT)_(\d+)$/.exec(error.text);
        if (match) throw new TgFloodWait(Number(match[1]));
        throw new AppError(error.code === 401 ? 'unauthenticated' : 'invalid', 'Telegram request failed');
      }
      throw error;
    }
  }
  async importSession(session: string): Promise<void> {
    const generation = this.generation;
    await this.call((c) => c.sdk.importSession(session));
    if (generation !== this.generation) throw new AppError('invalid', 'Connector stopped');
    this.session = session;
  }
  async exportSession(): Promise<string> {
    if (!this.client && this.session !== null) return this.session;
    this.session = await this.call((c) => c.sdk.exportSession());
    return this.session;
  }
  async sendCode(phone: string): Promise<{ phoneCodeHash: string }> {
    const code = await this.call((c) => c.sdk.sendCode({ phone }));
    if (!('phoneCodeHash' in code)) throw new AppError('invalid', 'Account already authorized; restart login');
    return { phoneCodeHash: code.phoneCodeHash };
  }
  async signIn(a: { phone: string; phoneCodeHash: string; code: string }) {
    try {
      return mtUser(
        await this.call((c) => c.sdk.signIn({ phone: a.phone, phoneCodeHash: a.phoneCodeHash, phoneCode: a.code })),
      );
    } catch (error) {
      // SESSION_PASSWORD_NEEDED must be recognized before safe generic RPC error translation.
      if (error instanceof AppError && error.message === 'Telegram password required')
        return 'password_needed' as const;
      throw error;
    }
  }
  async checkPassword(password: string) {
    return mtUser(await this.call((c) => c.sdk.checkPassword(password)));
  }
  async getMe() {
    return mtUser(await this.call((c) => c.sdk.getMe()));
  }
  async dialogs(o: { offset: string | null; limit: number }) {
    this.checkLimit(o.limit);
    const offset = o.offset === null ? null : offsetSchema.parse(JSON.parse(o.offset));
    const offsetPeer = offset ? this.peers.get(offset.peer) : { _: 'inputPeerEmpty' as const };
    if (!offsetPeer) throw new AppError('invalid', 'Dialog cursor requires this account listing');
    const res = await this.call((c) =>
      c.dialogs({
        _: 'messages.getDialogs',
        offsetId: offset?.id ?? 0,
        offsetDate: offset?.date ?? 0,
        offsetPeer,
        excludePinned: offset !== null,
        limit: o.limit,
        hash: Long.ZERO,
      }),
    );
    if (res._ === 'messages.dialogsNotModified') throw new AppError('invalid', 'Unexpected dialog response');
    const parsed = Dialog.parseTlDialogs(res);
    const dialogs = parsed.map((d) => {
      const peer = mtPeer(d.peer);
      this.peers.set(`${peer.type}:${peer.id}`, inputPeer(d.peer));
      return {
        peer,
        title: d.peer.displayName,
        lastMessageId: d.raw.topMessage || null,
        lastMessageDate: d.lastMessage?.raw.date ?? null,
      };
    });
    const last = parsed.at(-1);
    const seen = (offset?.seen ?? 0) + res.dialogs.length;
    const finished = res._ === 'messages.dialogs' || seen >= res.count || res.dialogs.length === 0;
    if (!finished && !last) throw new AppError('invalid', 'Dialog page has no resumable peer');
    const peer = last ? mtPeer(last.peer) : null;
    return {
      dialogs,
      next:
        finished || !last || !peer
          ? null
          : JSON.stringify({
              id: last.raw.topMessage,
              date: last.lastMessage?.raw.date ?? 0,
              peer: `${peer.type}:${peer.id}`,
              seen,
            }),
    };
  }
  async history(peer: TgPeer, o: { minId: number; maxId: number; limit: number }) {
    this.checkLimit(o.limit);
    const input = this.peers.get(`${peer.type}:${peer.id}`);
    if (!input) throw new AppError('invalid', 'List chats to rebuild account peer cache before history');
    const res = await this.call((c) =>
      c.history({
        _: 'messages.getHistory',
        peer: input,
        offsetId: o.maxId,
        offsetDate: 0,
        addOffset: 0,
        minId: o.minId,
        maxId: o.maxId,
        limit: o.limit,
        hash: Long.ZERO,
      }),
    );
    if (res._ === 'messages.messagesNotModified') throw new AppError('invalid', 'Unexpected history response');
    // Silently filtering holes would shorten a full page and falsely signal end-of-history to the neutral port.
    if (res.messages.some((m) => m._ === 'messageEmpty'))
      throw new AppError('invalid', 'History page contains unavailable messages');
    const peers = PeersIndex.from(res);
    return res.messages.filter((m) => m._ !== 'messageEmpty').map((m) => mtMessage(new Message(m, peers)));
  }
  async startUpdates(h: Parameters<TelegramApi['startUpdates']>[0]): Promise<void> {
    this.detach?.();
    const generation = ++this.generation;
    const client = this.getClient();
    const { sdk } = client;
    let failed = false;
    let authLost = false;
    const enqueue = (run: () => Promise<void>): Promise<void> => {
      const pending = this.queue.then(async () => {
        if (generation !== this.generation || failed) return;
        await run();
      });
      this.queue = pending.catch(() => {
        if (generation !== this.generation || failed) return;
        failed = true;
        this.detach?.();
        client.closeNow();
        void sdk.stopUpdatesLoop().catch(() => {});
        try {
          h.onState('disconnected');
        } catch {
          /* A broken state observer must not prevent cleanup. */
        }
        this.ctx.log('warn', 'connector.update_failed', { accountId: this.ctx.accountId });
      });
      return pending;
    };
    const onNew = (m: Message): Promise<void> => enqueue(() => h.onNew(mtMessage(m)));
    const onEdit = (m: Message): Promise<void> => enqueue(() => h.onEdit(mtMessage(m)));
    const onDelete = (d: Parameters<Parameters<typeof sdk.onDeleteMessage.add>[0]>[0]): Promise<void> =>
      enqueue(() =>
        h.onDelete({
          ids: d.messageIds,
          channelId: d.raw._ === 'updateDeleteChannelMessages' ? d.raw.channelId : null,
        }),
      );
    const onState = (s: Parameters<Parameters<typeof sdk.onConnectionState.add>[0]>[0]): void => {
      void enqueue(async () => h.onState(s === 'connected' ? 'connected' : 'disconnected')).catch(() => {});
    };
    const onError = (error: Error): void => {
      if (generation !== this.generation || failed) return;
      if (tl.RpcError.is(error) && error.code === 401 && error.text !== 'SESSION_PASSWORD_NEEDED') {
        // Latch synchronously in the real RPC observer, before UpdatesManager swallows the error.
        authLost = true;
        failed = true;
        this.detach?.();
        client.closeNow();
        void sdk.stopUpdatesLoop().catch(() => {});
        const notification = this.queue.then(() => {
          if (generation === this.generation) h.onState('auth_lost');
        });
        this.queue = notification.catch(() => {
          this.ctx.log('warn', 'connector.state_failed', { accountId: this.ctx.accountId });
        });
        return;
      }
      void enqueue(async () => h.onState('disconnected')).catch(() => {});
    };
    sdk.onNewMessage.add(onNew);
    sdk.onEditMessage.add(onEdit);
    sdk.onDeleteMessage.add(onDelete);
    sdk.onConnectionState.add(onState);
    sdk.onError.add(onError);
    this.detach = () => {
      sdk.onNewMessage.remove(onNew);
      sdk.onEditMessage.remove(onEdit);
      sdk.onDeleteMessage.remove(onDelete);
      sdk.onConnectionState.remove(onState);
      sdk.onError.remove(onError);
      this.detach = null;
    };
    try {
      await this.call((c) => c.sdk.connect());
      if (generation !== this.generation) return;
      if (authLost) throw new AppError('unauthenticated', 'Telegram authorization lost');
      await this.call((c) => c.sdk.startUpdatesLoop());
      if (generation !== this.generation) {
        await sdk.stopUpdatesLoop();
        return;
      }
      if (authLost) {
        // startLoop can restart its asynchronous loop AFTER the swallowed startup error.
        await sdk.stopUpdatesLoop();
        await this.queue;
        throw new AppError('unauthenticated', 'Telegram authorization lost');
      }
      if (generation === this.generation && !failed) onState('connected');
    } catch (error) {
      if (generation === this.generation) this.detach?.();
      if (authLost) {
        await sdk.stopUpdatesLoop();
        await this.queue;
        throw new AppError('unauthenticated', 'Telegram authorization lost');
      }
      throw error;
    }
  }
  async logOut(): Promise<void> {
    await this.call((c) => c.sdk.logOut());
    this.session = null;
  }
  async destroy(): Promise<void> {
    if (this.closing) return this.closing;
    ++this.generation;
    this.detach?.();
    this.queue = Promise.resolve();
    const client = this.client;
    this.client = null;
    this.peers.clear();
    if (!client) return;
    client.closeNow(); // Abort connects and close all sockets immediately, before any asynchronous SDK cleanup.
    const generation = this.generation;
    const cleanup = (async () => {
      try {
        const snapshot = await client.sdk.exportSession();
        if (generation === this.generation) this.session = snapshot;
      } catch {
        /* No authorized session exists during cancelled first login/start. */
      }
      await client.sdk.destroy();
    })();
    let finished = false;
    const tracked = cleanup.finally(() => {
      finished = true;
    });
    const timeout = this.ctx.sleep(5000).then(() => {
      if (!finished) throw new AppError('invalid', 'Telegram cleanup exceeded five seconds');
    });
    this.closing = Promise.race([tracked, timeout]);
    try {
      await this.closing;
    } finally {
      this.closing = null;
    }
  }
  private checkLimit(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new AppError('invalid', 'Telegram page limit must be 1 through 100');
  }
}

function inputPeer(peer: Peer): tl.TypeInputPeer {
  const input = peer.inputPeer;
  switch (input._) {
    case 'inputPeerUser':
    case 'inputPeerChat':
    case 'inputPeerChannel':
      return input;
    default:
      throw new AppError('invalid', 'Incomplete account peer in dialog listing');
  }
}
