import type { Db, Model, ModelConfig, OpenAIResponsesPort, OpLog, ScriptLine } from '../../contracts/index.ts';
import { AppError } from '../../contracts/index.ts';
export function createModel(
  cfg: ModelConfig,
  deps: {
    db: Db;
    oplog: OpLog;
    scriptLines?: ScriptLine[];
    openai?: OpenAIResponsesPort;
  },
): Promise<Model> {
  void cfg;
  void deps;
  throw new AppError('invalid', 'not built: createModel');
}
