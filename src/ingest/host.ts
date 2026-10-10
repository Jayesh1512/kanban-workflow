import type { AppConfig, ConnectorFactory, Db, Host, OpLog } from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';
export function createHost(deps: {
  db: Db;
  now(): Date;
  sleep(ms: number): Promise<void>;
  connectors: ConnectorFactory[];
  config: AppConfig;
  oplog: OpLog;
}): Host {
  void deps;
  return {
    listChannels() {
      throw new AppError('invalid', 'not built: listChannels');
    },
    listAccounts() {
      throw new AppError('invalid', 'not built: listAccounts');
    },
    beginLogin() {
      throw new AppError('invalid', 'not built: beginLogin');
    },
    continueLogin() {
      throw new AppError('invalid', 'not built: continueLogin');
    },
    disconnect() {
      throw new AppError('invalid', 'not built: disconnect');
    },
    listChats() {
      throw new AppError('invalid', 'not built: listChats');
    },
    chatCounts() {
      throw new AppError('invalid', 'not built: chatCounts');
    },
    includeChat() {
      throw new AppError('invalid', 'not built: includeChat');
    },
    excludeChat() {
      throw new AppError('invalid', 'not built: excludeChat');
    },
    confirmAgreement() {
      throw new AppError('invalid', 'not built: confirmAgreement');
    },
    markWithdrawn() {
      throw new AppError('invalid', 'not built: markWithdrawn');
    },
    setIncludeAll() {
      throw new AppError('invalid', 'not built: setIncludeAll');
    },
    startImport() {
      throw new AppError('invalid', 'not built: startImport');
    },
    startAll() {
      throw new AppError('invalid', 'not built: startAll');
    },
    stopAll() {
      throw new AppError('invalid', 'not built: stopAll');
    },
    settle() {
      throw new AppError('invalid', 'not built: settle');
    },
  };
}
export function agreementWording(): { version: number; text: string } {
  throw new AppError('invalid', 'not built: agreementWording');
}
