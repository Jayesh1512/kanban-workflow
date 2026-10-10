import type { Action, Ctx, Db, GuardFacts, Id, ModelDecision, Outcome, SetBy } from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';
export function readGuardFacts(db: Db, messageId: Id, decision: ModelDecision): GuardFacts {
  void db;
  void messageId;
  void decision;
  throw new AppError('invalid', 'not built: readGuardFacts');
}

export function judge(decision: ModelDecision, facts: GuardFacts): Outcome[] {
  void decision;
  void facts;
  throw new AppError('invalid', 'not built: judge');
}

export function applyAction(
  ctx: Ctx,
  action: Action,
  o: { decisionId: Id | null; reason: string; setBy: SetBy; followsHumanOverride: boolean },
): void {
  void ctx;
  void action;
  void o;
  throw new AppError('invalid', 'not built: applyAction');
}
