import type { Ctx, Db, Id } from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';

export function removeTeammate(ctx: Ctx, teammateId: Id, disconnect: (accountId: Id) => Promise<void>): Promise<void> {
  void ctx;
  void teammateId;
  void disconnect;
  throw new AppError('invalid', 'not built: removeTeammate');
}

export function listTeammates(ctx: Ctx): { id: Id; username: string; displayName: string }[] {
  void ctx;
  throw new AppError('invalid', 'not built: listTeammates');
}

export function signOut(db: Db, token: string): void {
  void db;
  void token;
  throw new AppError('invalid', 'not built: signOut');
}

export function revokeCredential(ctx: Ctx, credentialId: Id): void {
  void ctx;
  void credentialId;
  throw new AppError('invalid', 'not built: revokeCredential');
}

export function listCredentials(
  ctx: Ctx,
): { id: Id; name: string; scopeMessages: boolean; createdBy: string; revoked: boolean }[] {
  void ctx;
  throw new AppError('invalid', 'not built: listCredentials');
}

export type * from '../contracts/index.ts';

export {
  addTeammate,
  createCredential,
  credentialForToken,
  getSetting,
  open,
  seal,
  setSetting,
  signIn,
  teammateForSession,
} from './spine.ts';
