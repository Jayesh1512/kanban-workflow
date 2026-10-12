import type { Ctx, Id, MessageRecord } from '../../contracts/index.ts';
import { AppError } from '../../contracts/index.ts';
import { ensureIdentity, setContactCompany } from '../../graph/index.ts';
import { record } from '../../log/index.ts';

/** Joins the page transaction. Sighting identity is checked before touching graph/key state. */
export function storeOnce(
  system: Ctx,
  a: { id: Id; teammate_id: Id; channel: string },
  chatId: Id,
  m: MessageRecord,
  origin: 'live' | 'history',
): Id | null {
  const { db, now } = system;
  return db.tx(() => {
    if (
      !db.get(
        "SELECT ac.chat_id FROM account_chat ac JOIN chat ch ON ch.id=ac.chat_id JOIN channel_account a ON a.id=ac.account_id JOIN teammate t ON t.id=a.teammate_id JOIN identity self ON self.id=a.self_identity_id AND self.teammate_id=a.teammate_id AND self.channel=a.channel JOIN chat_selection cs ON cs.account_id=a.id AND cs.chat_key=ch.chat_key WHERE a.id=? AND ch.id=? AND ch.withdrawn_at IS NULL AND cs.decision='included' AND a.state IN ('connected','disconnected') AND a.session_sealed IS NOT NULL AND t.removed_at IS NULL",
        a.id,
        chatId,
      )
    )
      return null;
    const duplicate = db.get<{ message_id: Id; chat_id: Id }>(
      'SELECT ms.message_id,m.chat_id FROM message_sighting ms JOIN message m ON m.id=ms.message_id WHERE ms.account_id=? AND ms.native_id=?',
      a.id,
      m.nativeId,
    );
    if (duplicate) return duplicate.chat_id === chatId ? duplicate.message_id : null;
    const sender = ensureIdentity(system, { channel: a.channel, ...m.sender });
    const first = !db.get(
      'SELECT identity_id FROM chat_participant WHERE chat_id=? AND identity_id=?',
      chatId,
      sender.identityId,
    );
    db.run(
      'INSERT INTO chat_participant(chat_id,identity_id,first_seen_at) VALUES (?,?,?) ON CONFLICT(chat_id,identity_id) DO UPDATE SET first_seen_at=min(first_seen_at,excluded.first_seen_at)',
      chatId,
      sender.identityId,
      m.sentAt,
    );
    let key = m.key;
    let found = db.get<{ id: Id }>('SELECT id FROM message WHERE chat_id=? AND message_key=?', chatId, key);
    if (
      found &&
      db.get('SELECT message_id FROM message_sighting WHERE account_id=? AND message_id=?', a.id, found.id)
    ) {
      let n = 2;
      do {
        key = `${m.key}#${n++}`;
      } while (db.get('SELECT id FROM message WHERE chat_id=? AND message_key=?', chatId, key));
      found = undefined;
    }
    const id =
      found?.id ??
      db.run(
        'INSERT INTO message(chat_id,message_key,sender_identity_id,sent_at,text,media,reply_to_message_id,edited_at,origin,stored_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        chatId,
        key,
        sender.identityId,
        m.sentAt,
        m.text,
        m.media,
        null,
        m.editedAt,
        origin,
        now().toISOString(),
      ).lastInsertRowid;
    db.run('INSERT INTO message_sighting(account_id,message_id,native_id) VALUES (?,?,?)', a.id, id, m.nativeId);
    const source = db.get<{ reply_to_message_id: Id | null }>('SELECT reply_to_message_id FROM message WHERE id=?', id);
    if (m.replyToNativeId !== null) {
      const target = db.get<{ id: Id }>(
        'SELECT m.id FROM message_sighting ms JOIN message m ON m.id=ms.message_id WHERE ms.account_id=? AND ms.native_id=? AND m.chat_id=?',
        a.id,
        m.replyToNativeId,
        chatId,
      );
      if (
        target &&
        (target.id === id || (source?.reply_to_message_id != null && source.reply_to_message_id !== target.id))
      )
        throw new AppError('conflict', 'Stored reply conflicts');
      if (source?.reply_to_message_id === null) {
        db.run(
          'UPDATE message_sighting SET reply_to_native_id=? WHERE account_id=? AND message_id=?',
          m.replyToNativeId,
          a.id,
          id,
        );
        record(system, {
          action: 'message.reply_pending',
          subjectKind: 'message',
          subjectId: id,
          after: { accountId: a.id, recordedAt: now().toISOString() },
          messageIds: [id],
        });
      }
    }
    if (origin === 'live')
      db.run('UPDATE account_chat SET live_cursor=? WHERE account_id=? AND chat_id=?', m.cursor, a.id, chatId);
    const chat = db.get<{ kind: string; named_company_id: Id | null }>(
      'SELECT kind,named_company_id FROM chat WHERE id=?',
      chatId,
    );
    if (first && chat?.kind === 'direct' && chat.named_company_id !== null && sender.contactId !== null) {
      const link = db.get<{ set_by: string; removed: number }>(
        'SELECT set_by,removed FROM contact_company WHERE contact_id=? AND company_id=?',
        sender.contactId,
        chat.named_company_id,
      );
      if (link?.set_by !== 'human')
        setContactCompany(
          { ...system, actor: { kind: 'teammate', id: a.teammate_id } },
          sender.contactId,
          { company: { id: chat.named_company_id }, evidenceMessageIds: [id] },
          { setBy: 'human' },
        );
    }
    if (first && chat?.kind === 'group' && sender.contactId !== null) {
      for (const row of db.all<{ account_id: Id }>(
        "SELECT ac.account_id FROM account_chat ac JOIN chat ch ON ch.id=ac.chat_id WHERE ac.chat_id=? AND ac.agreement_stale_since IS NULL AND (SELECT ca.at FROM chat_agreement ca WHERE ca.account_id=ac.account_id AND ca.channel=ch.channel AND ca.chat_key=ch.chat_key AND ca.kind='confirmed' ORDER BY ca.id DESC LIMIT 1)<?",
        chatId,
        m.sentAt,
      )) {
        db.run(
          'UPDATE account_chat SET agreement_stale_since=? WHERE account_id=? AND chat_id=?',
          m.sentAt,
          row.account_id,
          chatId,
        );
        record(system, {
          action: 'chat.agreement_stale',
          subjectKind: 'chat',
          subjectId: chatId,
          after: { accountId: row.account_id },
          messageIds: [id],
        });
      }
    }
    return id;
  });
}
