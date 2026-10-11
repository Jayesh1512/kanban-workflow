import type { Ctx, Id } from '../../contracts/index.ts';
import { AppError } from '../../contracts/index.ts';
import { record } from '../../log/index.ts';

/** Durable sightings alone are authoritative, including duplicate-only pages. */
export function resolveReplies(ctx: Ctx, chatId: Id): Id[] {
  return ctx.db.tx(() => {
    const candidates = ctx.db.all<{ source: Id; target: Id; account: Id; existing: Id | null }>(
      `SELECT source.id AS source,target.id AS target,p.account_id AS account,source.reply_to_message_id AS existing
       FROM message_sighting p JOIN message source ON source.id=p.message_id
       JOIN message_sighting t ON t.account_id=p.account_id AND t.native_id=p.reply_to_native_id
       JOIN message target ON target.id=t.message_id AND target.chat_id=source.chat_id
       JOIN channel_account a ON a.id=p.account_id
       JOIN identity self ON self.id=a.self_identity_id AND self.teammate_id=a.teammate_id AND self.channel=a.channel
       JOIN teammate owner ON owner.id=a.teammate_id AND owner.removed_at IS NULL
       JOIN chat ch ON ch.id=source.chat_id AND ch.withdrawn_at IS NULL
       JOIN account_chat ac ON ac.account_id=a.id AND ac.chat_id=ch.id
       JOIN chat_selection cs ON cs.account_id=a.id AND cs.chat_key=ch.chat_key AND cs.decision='included'
       WHERE source.chat_id=? AND a.state IN ('connected','disconnected') AND a.session_sealed IS NOT NULL AND p.reply_to_native_id IS NOT NULL
       ORDER BY source.id,p.account_id`,
      chatId,
    );
    const chosen = new Map<Id, (typeof candidates)[number]>();
    // Validate ALL currently resolvable candidates BEFORE clearing ANY source.
    for (const c of candidates) {
      if (
        c.source === c.target ||
        (c.existing !== null && c.existing !== c.target) ||
        (chosen.has(c.source) && chosen.get(c.source)?.target !== c.target)
      )
        throw new AppError('conflict', 'Stored reply conflicts');
      chosen.set(c.source, c);
    }
    const cited: Id[] = [];
    for (const c of chosen.values()) {
      if (c.existing === null) {
        ctx.db.run('UPDATE message SET reply_to_message_id=? WHERE id=?', c.target, c.source);
        record(ctx, {
          action: 'message.reply_link',
          subjectKind: 'message',
          subjectId: c.source,
          before: { replyToId: null },
          after: { accountId: c.account, replyToId: c.target, linkedAt: ctx.now().toISOString() },
          messageIds: [c.source, c.target],
        });
      }
      ctx.db.run('UPDATE message_sighting SET reply_to_native_id=NULL WHERE message_id=?', c.source);
      cited.push(c.source, c.target);
    }
    return [...new Set(cited)];
  });
}
export function clearPending(ctx: Ctx, accountId: Id | null, chatId?: Id): void {
  if (accountId === null) {
    ctx.db.run(
      'UPDATE message_sighting SET reply_to_native_id=NULL WHERE message_id IN (SELECT id FROM message WHERE chat_id=?)',
      chatId ?? null,
    );
  } else if (chatId === undefined) {
    ctx.db.run('UPDATE message_sighting SET reply_to_native_id=NULL WHERE account_id=?', accountId);
  } else {
    ctx.db.run(
      'UPDATE message_sighting SET reply_to_native_id=NULL WHERE account_id=? AND message_id IN (SELECT id FROM message WHERE chat_id=?)',
      accountId,
      chatId,
    );
  }
}
