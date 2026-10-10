import type { AppConfig, ConnectorFactory, Db, Host, OpLog } from '../contracts/index.ts';
import { accountMethods, createAccounts } from './host/accounts.ts';
import { createScheduler } from './host/scheduler.ts';
import { createSelection } from './host/selection.ts';
import { createState } from './host/state.ts';

export { agreementWording } from './host/agreement.ts';

export function createHost(deps: {
  db: Db;
  now(): Date;
  sleep(ms: number): Promise<void>;
  connectors: ConnectorFactory[];
  config: AppConfig;
  oplog: OpLog;
}): Host {
  const state = createState(deps);
  const scheduler = createScheduler(state);
  const accounts = createAccounts(state, scheduler);
  return {
    ...accountMethods(state, accounts, scheduler),
    ...createSelection(state, scheduler),
    startAll: accounts.startAll,
    stopAll: accounts.stopAll,
    settle: scheduler.settle,
  };
}
