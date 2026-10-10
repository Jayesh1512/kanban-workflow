import type { Db, Model, MovementDecisionProvider, OpLog, Pipeline } from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';
export function createPipeline(deps: {
  db: Db;
  model: Model;
  movement: MovementDecisionProvider;
  now(): Date;
  sleep(ms: number): Promise<void>;
  oplog: OpLog;
}): Pipeline {
  void deps;
  return {
    start() {
      throw new AppError('invalid', 'not built: start');
    },
    stop() {
      throw new AppError('invalid', 'not built: stop');
    },
    processNext() {
      throw new AppError('invalid', 'not built: processNext');
    },
    drain() {
      throw new AppError('invalid', 'not built: drain');
    },
    status() {
      throw new AppError('invalid', 'not built: status');
    },
  };
}
