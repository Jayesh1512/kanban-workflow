import type { Ctx, Db, Id } from '../../contracts/index.ts';
import { openDb } from '../../store/db.ts';

export const start = '2026-10-10T00:00:00.000Z';
export function time(minute: number): string {
  return `2026-10-10T00:${String(minute).padStart(2, '0')}:00.000Z`;
}

/** SQL fixture construction only: no stand-in for a host, graph or view builder. */
export function fixture(path = ':memory:'): Ctx {
  const db = openDb(path);
  const ctx: Ctx = { db, actor: { kind: 'system' }, canReadText: true, now: () => new Date(start) };
  db.tx(() => {
    for (const id of [1, 2]) {
      db.run(
        'INSERT INTO teammate(id,username,display_name,password_hash,created_at) VALUES (?,?,?,?,?)',
        id,
        `teammate${id}`,
        `Teammate ${id}`,
        'synthetic',
        start,
      );
      db.run(
        "INSERT INTO identity(id,channel,user_key,display_name,teammate_id) VALUES (?,'fixture',?,?,?)",
        id,
        `self${id}`,
        `Self ${id}`,
        id,
      );
    }
    for (const [id, name] of ['Alice', 'Bob', 'Other'].entries()) {
      db.run('INSERT INTO contact(id,display_name,created_at) VALUES (?,?,?)', id + 1, name, start);
      db.run(
        "INSERT INTO identity(id,channel,user_key,display_name,contact_id) VALUES (?,'fixture',?,?,?)",
        id + 3,
        `outside${id}`,
        name,
        id + 1,
      );
    }
    for (const [id, name] of ['Acme', 'Beta', 'Removed', 'Card only', 'Named only', 'Mentioned'].entries())
      db.run(
        "INSERT INTO company(id,name,name_norm,created_by_kind,created_at) VALUES (?,?,?,'teammate',?)",
        id + 1,
        name,
        name.toLowerCase(),
        start,
      );
    db.run("INSERT INTO contact_company VALUES (1,1,'human',0),(1,2,'agent',0),(2,1,'agent',0),(2,3,'human',1)");
    db.run(
      "INSERT INTO channel_account(id,teammate_id,channel,self_identity_id,state,created_at) VALUES (1,1,'fixture',1,'connected',?),(2,2,'fixture',2,'removed',?),(3,1,'second',1,'connected',?)",
      start,
      start,
      start,
    );
    for (const id of [1, 2, 3, 4]) {
      db.run(
        "INSERT INTO chat(id,channel,chat_key,kind,title,named_company_id,created_at) VALUES (?,'fixture',?,'group',?,?,?)",
        id,
        `chat${id}`,
        `Chat ${id}`,
        id === 1 ? 1 : id === 3 ? 5 : null,
        start,
      );
      for (const identity of id <= 2 ? [id, 3, ...(id === 1 ? [4] : [])] : [5])
        db.run('INSERT INTO chat_participant VALUES (?,?,?)', id, identity, start);
    }
    db.run('INSERT INTO lane(id,name,sop,position,created_at) VALUES (1,?,?,0,?)', 'Lane', 'SOP', start);
    db.run("INSERT INTO stage(id,lane_id,name,position) VALUES (1,1,'Start',0)");
    for (const id of [1, 2])
      db.run(
        "INSERT INTO card(id,lane_id,stage_id,title,company_id,created_by_kind,last_change_by_kind,created_at) VALUES (?,1,1,?,?,'teammate','teammate',?)",
        id,
        `Card ${id}`,
        id === 1 ? 4 : 1,
        start,
      );
    addMessage(db, 1, 1, 3, 0, 'Café planted phrase', 'history');
    addMessage(db, 2, 1, 1, 1, 'Edited planted phrase');
    addMessage(db, 3, 2, 2, 1, 'Shared planted phrase');
    addMessage(db, 4, 2, 3, 2, 'Café planted phrase with "quotes"');
    addMessage(db, 5, 3, 5, 3, 'Named planted phrase');
    addMessage(db, 6, 4, 5, 4, 'Unrelated words');
    db.run(
      'UPDATE message SET media=?,reply_to_message_id=1,version=2,edited_at=?,deleted_at=? WHERE id=2',
      'document',
      time(2),
      time(3),
    );
    db.run('INSERT INTO message_version VALUES (2,1,?,?)', 'Earlier secret phrase', time(2));
    db.run("INSERT INTO card_message VALUES (1,1,'agent'),(2,1,'agent'),(3,2,'human'),(4,NULL,'human')");
    db.run("INSERT INTO message_sighting VALUES (1,1,'a1'),(2,1,'b1'),(3,1,'c1'),(2,2,'b2'),(1,3,'a3'),(2,4,'b4')");
    db.run('INSERT INTO company_reference(from_company_id,to_company_id,message_id,card_id) VALUES (1,6,1,1)');
  });
  return ctx;
}

export function addMessage(
  db: Db,
  id: Id,
  chatId: Id,
  senderId: Id,
  minute: number,
  text: string,
  origin = 'live',
): void {
  db.run(
    'INSERT INTO message(id,chat_id,message_key,sender_identity_id,sent_at,text,origin,stored_at) VALUES (?,?,?,?,?,?,?,?)',
    id,
    chatId,
    `m${id}`,
    senderId,
    time(minute),
    text,
    origin,
    time(10),
  );
}
