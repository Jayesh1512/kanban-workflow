import type { AppConfig, Db, Host, Model, OpLog, Pipeline } from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';
import { routeInventory } from './routes.ts';
export function createWeb(deps: {
  db: Db;
  now(): Date;
  host: Host;
  pipeline: Pipeline;
  model: Model;
  config: AppConfig;
  oplog: OpLog;
}): { fetch(req: Request): Promise<Response>; routes: { method: string; path: string; public: boolean }[] } {
  void deps;
  return {
    fetch: async () => {
      throw new AppError('invalid', 'not built: fetch');
    },
    routes: routeInventory(),
  };
}
export type * from '../contracts/index.ts';
