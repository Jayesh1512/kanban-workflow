import { createHash } from 'node:crypto';
import type { Ctx, Db, Id } from '../contracts/index.ts';
import { AppError, IdSchema } from '../contracts/index.ts';
import { record } from '../log/index.ts';
import { requireTeammate } from './core.ts';

export async function removeTeammate(
  ctx: Ctx,
  teammateId: Id,
  disconnect: (accountId: Id) => Promise<void>,
): Promise<void> {
  requireTeammate(ctx);
  if (!IdSchema.safeParse(teammateId).success) throw new AppError('invalid', 'Invalid teammate id');
  const accounts = ctx.db.tx(() => {
    if (!ctx.db.get('SELECT id FROM teammate WHERE id=? AND removed_at IS NULL', teammateId))
      throw new AppError('not_found', 'Teammate not found');
    const at = ctx.now().toISOString();
    const owned = ctx.db.all<{ id: Id }>('SELECT id FROM channel_account WHERE teammate_id=? ORDER BY id', teammateId);
    ctx.db.run('UPDATE teammate SET removed_at=? WHERE id=?', at, teammateId);
    ctx.db.run('DELETE FROM web_session WHERE teammate_id=?', teammateId);
    record(ctx, { action: 'teammate.remove', subjectKind: 'teammate', subjectId: teammateId });
    for (const credential of ctx.db.all<{ id: Id }>(
      'SELECT id FROM credential WHERE created_by=? AND revoked_at IS NULL',
      teammateId,
    )) {
      ctx.db.run('UPDATE credential SET revoked_at=? WHERE id=?', at, credential.id);
      record(ctx, { action: 'credential.revoke', subjectKind: 'credential', subjectId: credential.id });
    }
    return owned;
  });
  // The caller binds host.disconnect to a system Ctx. Removal is committed before any asynchronous teardown.
  let failed = false;
  for (const account of accounts) {
    try {
      await disconnect(account.id);
    } catch {
      failed = true;
    }
  }
  if (failed) throw new AppError('conflict', 'Teammate removed; account disconnect incomplete');
}

export function listTeammates(ctx: Ctx): { id: Id; username: string; displayName: string }[] {
  requireTeammate(ctx);
  return ctx.db.all(
    'SELECT id,username,display_name AS displayName FROM teammate WHERE removed_at IS NULL ORDER BY id',
  );
}
export function signOut(db: Db, token: string): void {
  db.tx(() => db.run('DELETE FROM web_session WHERE token_hash=?', createHash('sha256').update(token).digest('hex')));
}
export function revokeCredential(ctx: Ctx, credentialId: Id): void {
  requireTeammate(ctx);
  if (!IdSchema.safeParse(credentialId).success) throw new AppError('invalid', 'Invalid credential id');
  ctx.db.tx(() => {
    const credential = ctx.db.get<{ revoked_at: string | null }>(
      'SELECT revoked_at FROM credential WHERE id=?',
      credentialId,
    );
    if (!credential) throw new AppError('not_found', 'Credential not found');
    if (credential.revoked_at !== null) return;
    ctx.db.run('UPDATE credential SET revoked_at=? WHERE id=?', ctx.now().toISOString(), credentialId);
    record(ctx, { action: 'credential.revoke', subjectKind: 'credential', subjectId: credentialId });
  });
}
export function listCredentials(
  ctx: Ctx,
): { id: Id; name: string; scopeMessages: boolean; scopeWrite: boolean; createdBy: string; revoked: boolean }[] {
  requireTeammate(ctx);
  return ctx.db
    .all<{ id: Id; name: string; scope_messages: number; scope_write: number; createdBy: string; revoked: number }>(
      'SELECT c.id,c.name,c.scope_messages,c.scope_write,t.display_name AS createdBy,c.revoked_at IS NOT NULL AS revoked FROM credential c JOIN teammate t ON t.id=c.created_by ORDER BY c.id',
    )
    .map(({ scope_messages, scope_write, revoked, ...row }) => ({
      ...row,
      scopeMessages: Boolean(scope_messages),
      scopeWrite: Boolean(scope_write),
      revoked: Boolean(revoked),
    }));
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
} from './core.ts';
