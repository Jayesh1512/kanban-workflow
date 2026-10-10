import type { TestContext } from 'node:test';
import { testApp } from '../../test/harness.ts';
import type { Ctx, Id } from '../contracts/index.ts';
import { ensureIdentity } from '../graph/index.ts';

/** Small controlled SQL input, not a replacement for host/pipeline behavior. */
export async function fixture(t: TestContext) {
  const h = await testApp({
    lines: ['alice', 'bob'].map((name) => ({
      t: 'account' as const,
      account: name,
      self: { userKey: `self-${name}`, displayName: name, handle: null },
    })),
    teammates: [
      { username: 'alice', account: 'alice' },
      { username: 'bob', account: 'bob' },
    ],
    script: [],
  });
  t.after(async () => {
    await h.app.stop();
    h.close();
  });
  const ctx = h.ctxFor('alice');
  const agent: Ctx = { ...ctx, actor: { kind: 'agent' } };
  const identity = ensureIdentity(ctx, {
    channel: 'fixture',
    userKey: 'client',
    displayName: 'Client',
    handle: 'client',
  });
  if (identity.contactId === null) throw new Error('Outside contact missing');
  const contactId = identity.contactId;
  const accountIds = ['alice', 'bob'].map((name) => {
    const c = h.ctxFor(name);
    const account = h.db.get<{ id: Id }>(
      'SELECT id FROM channel_account WHERE teammate_id=?',
      c.actor.kind === 'teammate' ? c.actor.id : null,
    );
    if (!account) throw new Error('Account missing');
    return account.id;
  });
  const chat = (key: string, accountIndex = 0, participantId: Id | null = identity.identityId) => {
    const id = h.db.run(
      "INSERT INTO chat(channel,chat_key,kind,title,created_at) VALUES ('fixture',?,'direct',?,?)",
      key,
      `Chat ${key}`,
      h.clock.now().toISOString(),
    ).lastInsertRowid;
    h.db.run(
      "INSERT INTO account_chat(account_id,chat_id,native_chat_id,sync_state) VALUES (?,?,?,'idle')",
      accountIds[accountIndex] ?? (accountIds[0] as Id),
      id,
      key,
    );
    h.db.run(
      "INSERT INTO chat_selection(account_id,chat_key,decision,decided_at) VALUES (?,?,'included',?)",
      accountIds[accountIndex] ?? (accountIds[0] as Id),
      key,
      h.clock.now().toISOString(),
    );
    if (participantId !== null)
      h.db.run(
        'INSERT INTO chat_participant(chat_id,identity_id,first_seen_at) VALUES (?,?,?)',
        id,
        participantId,
        h.clock.now().toISOString(),
      );
    return id;
  };
  let messageNo = 0;
  const message = (chatId: Id, text = 'Stored fixture phrase', senderId = identity.identityId) => {
    messageNo++;
    const at = h.clock.now().toISOString();
    const id = h.db.run(
      "INSERT INTO message(chat_id,message_key,sender_identity_id,sent_at,text,origin,stored_at,processed_version) VALUES (?,?,?,?,?,'live',?,1)",
      chatId,
      `m-${messageNo}`,
      senderId,
      at,
      text,
      at,
    ).lastInsertRowid;
    for (const r of h.db.all<{ account_id: Id }>('SELECT account_id FROM account_chat WHERE chat_id=?', chatId))
      h.db.run(
        'INSERT INTO message_sighting(account_id,message_id,native_id) VALUES (?,?,?)',
        r.account_id,
        id,
        `n-${id}`,
      );
    return id;
  };
  const chatId = chat('one'),
    otherChatId = chat('two', 1);
  return { h, ctx, agent, contactId, identityId: identity.identityId, chatId, otherChatId, chat, message };
}
