import type { Ctx, Db, Id, IsoTime } from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';
export function addTeammate(ctx: Ctx, i: { username: string; displayName: string; password: string }): Id {
  void ctx;
  void i;
  throw new AppError('invalid', 'not built: addTeammate');
}

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

export function signIn(db: Db, username: string, password: string, now: Date): { token: string; expiresAt: IsoTime } {
  void db;
  void username;
  void password;
  void now;
  throw new AppError('invalid', 'not built: signIn');
}

export function signOut(db: Db, token: string): void {
  void db;
  void token;
  throw new AppError('invalid', 'not built: signOut');
}

export function teammateForSession(db: Db, token: string, now: Date): Id | null {
  void db;
  void token;
  void now;
  throw new AppError('invalid', 'not built: teammateForSession');
}

export function createCredential(ctx: Ctx, i: { name: string; scopeMessages: boolean }): { id: Id; token: string } {
  void ctx;
  void i;
  throw new AppError('invalid', 'not built: createCredential');
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

export function credentialForToken(db: Db, token: string): { id: Id; scopeMessages: boolean } | null {
  void db;
  void token;
  throw new AppError('invalid', 'not built: credentialForToken');
}

export function getSetting<T>(db: Db, key: string): T {
  void db;
  void key;
  throw new AppError('invalid', 'not built: getSetting');
}

export function setSetting(ctx: Ctx, key: string, value: unknown): void {
  void ctx;
  void key;
  void value;
  throw new AppError('invalid', 'not built: setSetting');
}

export function seal(key: Uint8Array, plaintext: string): Uint8Array {
  void key;
  void plaintext;
  throw new AppError('invalid', 'not built: seal');
}

export function open(key: Uint8Array, sealed: Uint8Array): string {
  void key;
  void sealed;
  throw new AppError('invalid', 'not built: open');
}
export type * from '../contracts/index.ts';
