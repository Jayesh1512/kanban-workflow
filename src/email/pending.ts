import type { SqlExecutor } from '../shared/ports.js';

/** Approval wrote the thread into the Telegram-style source tables: release its held messages. */
export async function promotePendingEmail(tx: SqlExecutor, chatId: string): Promise<void> {
  const rows = (await tx.query('SELECT id,pending FROM email_messages WHERE chat_id=$1 AND pending IS NOT NULL ORDER BY id', [chatId])).rows;
  for (const row of rows) {
    const m = row['pending'] as Record<string, any>; // validated by EmailIngest before it was stored
    await tx.query(`INSERT INTO messages(chat_id,id,sender_id,sent_at,text,source_url,sender_snapshot,peer_snapshot,forward_metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(chat_id,id) DO NOTHING`,
    [chatId, row['id'], m['senderId'], m['sentAt'], m['text'], m['sourceUrl'], JSON.stringify(m['sender']), JSON.stringify(m['peer']), JSON.stringify(m['forward'])]);
  }
  await tx.query('UPDATE email_messages SET pending=NULL WHERE chat_id=$1 AND pending IS NOT NULL', [chatId]);
}

/** Rejected or re-excluded threads keep no business content. */
export async function dropPendingEmail(tx: SqlExecutor, chatId: string): Promise<void> {
  await tx.query('UPDATE email_messages SET pending=NULL WHERE chat_id=$1 AND pending IS NOT NULL', [chatId]);
}
