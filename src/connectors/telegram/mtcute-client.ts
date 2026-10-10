import type { ITelegramConnection, TelegramTransport } from '@mtcute/node';
import { MemoryStorage, NodePlatform, networkMiddlewares, TcpTransport, TelegramClient, tl } from '@mtcute/node';
import type { ConnectorContext } from '../../contracts/index.ts';
import { AppError } from '../../contracts/index.ts';

/** Internal SDK seam. Production gets exactly these operations; no chat mutation helper is exposed. */
export interface MtcuteClient {
  storage: MemoryStorage;
  sdk: Pick<
    TelegramClient,
    | 'importSession'
    | 'exportSession'
    | 'sendCode'
    | 'signIn'
    | 'checkPassword'
    | 'getMe'
    | 'connect'
    | 'startUpdatesLoop'
    | 'stopUpdatesLoop'
    | 'logOut'
    | 'destroy'
    | 'onNewMessage'
    | 'onEditMessage'
    | 'onDeleteMessage'
    | 'onConnectionState'
    | 'onError'
  >;
  dialogs(request: tl.messages.RawGetDialogsRequest): Promise<tl.messages.TypeDialogs>;
  history(request: tl.messages.RawGetHistoryRequest): Promise<tl.messages.TypeMessages>;
  closeNow(): void;
}
export function createMtcuteClient(
  ctx: ConnectorContext,
  transport: TelegramTransport = new TcpTransport(),
): MtcuteClient {
  const apiId = Number(ctx.config.API_ID);
  if (!Number.isSafeInteger(apiId) || apiId <= 0 || !ctx.config.API_HASH || !ctx.config.APP_OWNER)
    throw new AppError('invalid', 'Telegram API_ID, API_HASH and APP_OWNER are required');
  const abort = new AbortController();
  const connections = new Set<ITelegramConnection>();
  const platform = new NodePlatform();
  platform.getDefaultLogLevel = () => 0;
  platform.log = () => {}; // SDK logs can contain raw payloads/credentials; only our fixed OpLog events are permitted.
  const guarded: TelegramTransport = {
    packetCodec: (dc) => transport.packetCodec(dc),
    async connect(dc, signal) {
      const connection = await transport.connect(dc, AbortSignal.any([signal, abort.signal]));
      if (abort.signal.aborted) {
        await connection.close();
        throw new AppError('invalid', 'Connector stopped');
      }
      connections.add(connection);
      return connection;
    },
  };
  const storage = new MemoryStorage();
  const client = new TelegramClient({
    apiId,
    apiHash: ctx.config.API_HASH,
    storage,
    platform,
    transport: guarded,
    storageOptions: { cleanup: false },
    updates: { catchUp: false },
    network: {
      // Observe auth loss before the update manager can swallow it. No retry/wait middleware is installed.
      middlewares: [
        networkMiddlewares.onRpcError((_request, error) => {
          if (error.errorCode === 401 && error.errorMessage !== 'SESSION_PASSWORD_NEEDED')
            client.onError.emit(tl.RpcError.fromTl(error));
        }),
      ],
    },
    logLevel: 0,
  });
  return {
    sdk: client,
    storage,
    dialogs: (request) => client.call(request),
    history: (request) => client.call(request),
    closeNow() {
      abort.abort();
      for (const connection of connections) {
        void Promise.resolve(connection.close()).catch(() =>
          ctx.log('warn', 'connector.transport_close_failed', { accountId: ctx.accountId }),
        );
      }
      connections.clear();
    },
  };
}
