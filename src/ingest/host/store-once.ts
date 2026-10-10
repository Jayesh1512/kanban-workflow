import type { Ctx, Id } from '../../contracts/index.ts';
import { ensureIdentity, setContactCompany } from '../../graph/index.ts';

export function storeOnce(
  system: Ctx,
  a: { id: Id; teammate_id: Id; channel: string },
  chatId: Id,
  m: import('../../contracts/index.ts').MessageRecord,
  origin: 'live' | 'history',
): void {
  const { db, now } = system;
  db.tx(() => {
    if (db.get('SELECT message_id FROM message_sighting WHERE account_id=? AND native_id=?', a.id, m.nativeId)) return;
    const sender = ensureIdentity(system, { channel: a.channel, ...m.sender });
    db.run(
      'INSERT OR IGNORE INTO chat_participant(chat_id,identity_id,first_seen_at) VALUES (?,?,?)',
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
    const reply =
      m.replyToNativeId === null
        ? null
        : (db.get<{ message_id: Id }>(
            'SELECT message_id FROM message_sighting WHERE account_id=? AND native_id=?',
            a.id,
            m.replyToNativeId,
          )?.message_id ?? null);
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
        reply,
        m.editedAt,
        origin,
        now().toISOString(),
      ).lastInsertRowid;
    db.run('INSERT INTO message_sighting(account_id,message_id,native_id) VALUES (?,?,?)', a.id, id, m.nativeId);
    if (origin === 'live')
      db.run('UPDATE account_chat SET live_cursor=? WHERE account_id=? AND chat_id=?', m.cursor, a.id, chatId);
    const chat = db.get<{ kind: string; named_company_id: Id | null }>(
      'SELECT kind,named_company_id FROM chat WHERE id=?',
      chatId,
    );
    if (
      chat?.kind === 'direct' &&
      chat.named_company_id !== null &&
      sender.contactId !== null &&
      !db.get(
        'SELECT contact_id FROM contact_company WHERE contact_id=? AND company_id=?',
        sender.contactId,
        chat.named_company_id,
      )
    )
      setContactCompany(
        { ...system, actor: { kind: 'teammate', id: a.teammate_id } },
        sender.contactId,
        { company: { id: chat.named_company_id }, evidenceMessageIds: [id] },
        { setBy: 'human' },
      );
  });
}
