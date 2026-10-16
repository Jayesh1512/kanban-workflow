import type { Ctx, Id } from '../contracts/index.ts';
export function eligibleChat(ctx: Ctx, chatId: Id): boolean {
  return (
    ctx.canReadText &&
    Boolean(
      ctx.db.get(
        `SELECT ch.id FROM chat ch WHERE ch.id=? AND ch.withdrawn_at IS NULL
  AND EXISTS(SELECT 1 FROM account_chat ac JOIN channel_account ca ON ca.id=ac.account_id JOIN teammate t ON t.id=ca.teammate_id JOIN chat_selection cs ON cs.account_id=ca.id AND cs.chat_key=ch.chat_key WHERE ac.chat_id=ch.id AND ca.channel=ch.channel AND ca.state NOT IN ('login','removed','auth_lost') AND t.removed_at IS NULL AND cs.decision='included')
  AND NOT EXISTS(SELECT 1 FROM account_chat ac WHERE ac.chat_id=ch.id AND ac.sync_state<>'idle')`,
        chatId,
      ),
    )
  );
}
export function eligibleMessage(ctx: Ctx, id: Id, version: number): boolean {
  const row = ctx.db.get<{ chat_id: Id }>(
    'SELECT chat_id FROM message WHERE id=? AND version=? AND processed_version<version AND deleted_at IS NULL',
    id,
    version,
  );
  return Boolean(row && eligibleChat(ctx, row.chat_id));
}
