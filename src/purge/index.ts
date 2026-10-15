import { forgetMessages as forgetAgent } from '../agent/index.ts';
import { forgetMessages as forgetBoard } from '../board/index.ts';
import type { Ctx, Host, Id } from '../contracts/index.ts';
import { AppError, IdSchema } from '../contracts/index.ts';
import { forgetMessages as forgetGraph } from '../graph/index.ts';
import { deleteMessages } from '../ingest/index.ts';
import { record, redact, redactUnscopedMovementFeedback } from '../log/index.ts';

export function withdrawChat(ctx: Ctx, host: Host, accountId: Id, chatId: Id): void {
  if (ctx.actor.kind !== 'teammate') throw new AppError('forbidden', 'Account owner required');
  if (!IdSchema.safeParse(accountId).success || !IdSchema.safeParse(chatId).success)
    throw new AppError('invalid', 'Invalid withdrawal scope');
  // Validate before even opening the erasure transaction. Host repeats this check
  // under the write lock; no caller can substitute an unrelated account or chat.
  if (
    !ctx.db.get(
      `SELECT ch.id FROM channel_account ca JOIN teammate t ON t.id=ca.teammate_id
     JOIN account_chat ac ON ac.account_id=ca.id JOIN chat ch ON ch.id=ac.chat_id
     JOIN chat_selection cs ON cs.account_id=ca.id AND cs.chat_key=ch.chat_key
     WHERE ca.id=? AND ca.teammate_id=? AND t.removed_at IS NULL AND ch.id=?
     AND ch.channel=ca.channel AND ch.withdrawn_at IS NULL AND cs.decision='included'`,
      accountId,
      ctx.actor.id,
      chatId,
    )
  )
    throw new AppError('forbidden', 'Included owner chat required');
  ctx.db.tx(() => {
    ctx.db.run('PRAGMA defer_foreign_keys=ON');
    const messageIds = host.markWithdrawn(ctx, accountId, chatId);
    const agent = forgetAgent(ctx, messageIds);
    const board = forgetBoard(ctx, messageIds);
    const graph = forgetGraph(ctx, { messageIds, chatId });
    redact(ctx, {
      messageIds,
      decisionIds: agent.decisionIds,
      cardIds: [...board.removedCardIds, ...board.clearedCardIds],
      reviewItemIds: agent.reviewItemIds,
      contactIds: [...graph.removedContactIds, ...graph.resetContactIds],
      companyIds: graph.removedCompanyIds,
    });
    // This authorized global boundary also runs for a legitimately empty chat.
    redactUnscopedMovementFeedback(ctx);
    deleteMessages(ctx, messageIds);
    record(ctx, { action: 'chat.withdraw', subjectKind: 'chat', subjectId: chatId });
  });
  const checkpoint = ctx.db.get<{ busy: number }>('PRAGMA wal_checkpoint(TRUNCATE)');
  if (checkpoint?.busy !== 0)
    throw new AppError('conflict', 'Withdrawal committed; database cleanup is waiting for an active reader.');
}
