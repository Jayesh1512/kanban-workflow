import { z } from 'zod';
import type { Ctx, Id } from '../contracts/index.ts';
import { AppError, IdSchema, ParticipantRefSchema } from '../contracts/index.ts';
import { record } from '../log/index.ts';
import { validate } from './helpers.ts';

export function ensureIdentity(
  ctx: Ctx,
  p: { channel: string; userKey: string; displayName: string; handle: string | null },
): { identityId: Id; contactId: Id | null; teammateId: Id | null } {
  validate(z.strictObject({ channel: z.string().regex(/^[a-z][a-z0-9_]*$/), ...ParticipantRefSchema.shape }), p);
  return ctx.db.tx(() => {
    const existing = ctx.db.get<{
      id: Id;
      contact_id: Id | null;
      teammate_id: Id | null;
      display_name: string;
      handle: string | null;
    }>('SELECT * FROM identity WHERE channel=? AND user_key=?', p.channel, p.userKey);
    if (existing) {
      if (existing.display_name !== p.displayName || existing.handle !== p.handle) {
        ctx.db.run('UPDATE identity SET display_name=?,handle=? WHERE id=?', p.displayName, p.handle, existing.id);
        if (existing.contact_id !== null)
          ctx.db.run(
            "UPDATE contact SET display_name=? WHERE id=? AND name_set_by='agent'",
            p.displayName,
            existing.contact_id,
          );
        record(ctx, {
          action: 'contact.update',
          subjectKind: 'contact',
          subjectId: existing.contact_id,
          before: { identityId: existing.id },
          after: { identityId: existing.id, displayName: p.displayName, handle: p.handle },
        });
      }
      return { identityId: existing.id, contactId: existing.contact_id, teammateId: existing.teammate_id };
    }
    const contactId = ctx.db.run(
      'INSERT INTO contact(display_name,created_at) VALUES (?,?)',
      p.displayName,
      ctx.now().toISOString(),
    ).lastInsertRowid;
    const identityId = ctx.db.run(
      'INSERT INTO identity(channel,user_key,display_name,handle,contact_id) VALUES (?,?,?,?,?)',
      p.channel,
      p.userKey,
      p.displayName,
      p.handle,
      contactId,
    ).lastInsertRowid;
    record(ctx, {
      action: 'contact.update',
      subjectKind: 'contact',
      subjectId: contactId,
      after: { identityId, displayName: p.displayName },
    });
    return { identityId, contactId, teammateId: null };
  });
}
export function bindSelfIdentity(
  ctx: Ctx,
  p: { channel: string; userKey: string; displayName: string; handle: string | null; teammateId: Id },
): Id {
  validate(
    z.strictObject({
      channel: z.string().regex(/^[a-z][a-z0-9_]*$/),
      ...ParticipantRefSchema.shape,
      teammateId: IdSchema,
    }),
    p,
  );
  return ctx.db.tx(() => {
    if (!ctx.db.get('SELECT id FROM teammate WHERE id=? AND removed_at IS NULL', p.teammateId))
      throw new AppError('not_found', 'Teammate not found');
    const r = ctx.db.get<{ id: Id; contact_id: Id | null; teammate_id: Id | null }>(
      'SELECT * FROM identity WHERE channel=? AND user_key=?',
      p.channel,
      p.userKey,
    );
    if (r) {
      if (r.teammate_id !== null && r.teammate_id !== p.teammateId)
        throw new AppError('conflict', 'Identity belongs to another teammate');
      if (r.contact_id !== null) {
        ctx.db.run(
          'UPDATE identity SET contact_id=NULL,teammate_id=?,display_name=?,handle=? WHERE id=?',
          p.teammateId,
          p.displayName,
          p.handle,
          r.id,
        );
        if (!ctx.db.get('SELECT id FROM identity WHERE contact_id=?', r.contact_id)) {
          ctx.db.run('DELETE FROM contact_company WHERE contact_id=?', r.contact_id);
          ctx.db.run('DELETE FROM contact WHERE id=?', r.contact_id);
          record(ctx, {
            action: 'contact.retire',
            subjectKind: 'contact',
            subjectId: r.contact_id,
            after: { identityId: r.id, teammateId: p.teammateId },
          });
        }
        record(ctx, {
          action: 'account.connect',
          subjectKind: 'teammate',
          subjectId: p.teammateId,
          after: { identityId: r.id },
        });
      } else if (
        ctx.db.run(
          'UPDATE identity SET display_name=?,handle=? WHERE id=? AND (display_name<>? OR handle IS NOT ?)',
          p.displayName,
          p.handle,
          r.id,
          p.displayName,
          p.handle,
        ).changes
      ) {
        record(ctx, {
          action: 'account.connect',
          subjectKind: 'teammate',
          subjectId: p.teammateId,
          after: { identityId: r.id },
        });
      }
      return r.id;
    }
    const id = ctx.db.run(
      'INSERT INTO identity(channel,user_key,display_name,handle,teammate_id) VALUES (?,?,?,?,?)',
      p.channel,
      p.userKey,
      p.displayName,
      p.handle,
      p.teammateId,
    ).lastInsertRowid;
    record(ctx, {
      action: 'account.connect',
      subjectKind: 'teammate',
      subjectId: p.teammateId,
      after: { identityId: id },
    });
    return id;
  });
}
