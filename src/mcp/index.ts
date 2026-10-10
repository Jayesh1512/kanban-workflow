import type { AppConfig, Db, OpLog } from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';
export function createMcp(deps: { db: Db; now(): Date; config: AppConfig; oplog: OpLog }): {
  fetch(req: Request): Promise<Response>;
} {
  void deps;
  return {
    fetch: async () => {
      throw new AppError('invalid', 'not built: fetch');
    },
  };
}
export type * from '../contracts/index.ts';
