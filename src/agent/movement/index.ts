import type {
  Db,
  MovementConfig,
  MovementDecisionProvider,
  MovementHttpPort,
  MovementReplayLine,
  OpLog,
} from '../../contracts/index.ts';
import { AppError } from '../../contracts/index.ts';
export function createMovementProvider(
  cfg: MovementConfig,
  deps: {
    db: Db;
    oplog: OpLog;
    now(): Date;
    sleep(ms: number): Promise<void>;
    http: MovementHttpPort;
    replayLines?: MovementReplayLine[];
  },
): Promise<MovementDecisionProvider> {
  void cfg;
  void deps;
  throw new AppError('invalid', 'not built: createMovementProvider');
}
