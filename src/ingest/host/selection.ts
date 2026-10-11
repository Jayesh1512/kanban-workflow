import { z } from 'zod';
import { getSetting } from '../../auth/index.ts';
import type { Host, Id } from '../../contracts/index.ts';
import { AppError, IdSchema } from '../../contracts/index.ts';
import { ensureCompany, setContactCompany } from '../../graph/index.ts';
import { record } from '../../log/index.ts';
import { agreementWording } from './agreement.ts';
import { clearPending } from './replies.ts';
import type { Scheduler } from './scheduler.ts';
import type { Account, State } from './state.ts';
import { assertAccountOrigins } from './sync-origin.ts';

function agree(s: State, a: Account, chatKey: string): void {
  const wording = agreementWording();
  s.db.run(
    "INSERT INTO chat_agreement(account_id,channel,chat_key,kind,teammate_id,at,wording_version,wording) VALUES (?,?,?,'confirmed',?,?,?,?)",
    a.id,
    a.channel,
    chatKey,
    a.teammate_id,
    s.now().toISOString(),
    wording.version,
    wording.text,
  );
}
function selected(s: State, a: Account, chatId: Id): { chat_key: string } {
  if (!IdSchema.safeParse(chatId).success) throw new AppError('invalid', 'Invalid chat id');
  const chat = s.db.get<{ chat_key: string }>(
    "SELECT ch.chat_key FROM chat ch JOIN account_chat ac ON ac.chat_id=ch.id JOIN chat_selection cs ON cs.account_id=ac.account_id AND cs.chat_key=ch.chat_key WHERE ch.id=? AND ch.channel=? AND ac.account_id=? AND cs.decision='included' AND ch.withdrawn_at IS NULL",
    chatId,
    a.channel,
    a.id,
  );
  if (!chat) throw new AppError('forbidden', 'Included owner chat required');
  return chat;
}
export function createSelection(
  s: State,
  scheduler: Scheduler,
): Pick<Host, 'includeChat' | 'excludeChat' | 'confirmAgreement' | 'markWithdrawn' | 'setIncludeAll' | 'startImport'> {
  return {
    includeChat(ctx, accountId, chatKey, input) {
      const a = s.owner(ctx, accountId);
      assertAccountOrigins(s.db, a.id);
      if (!s.active(a.id)) throw new AppError('unauthenticated', 'Reconnect account before inclusion');
      const parsed = z
        .strictObject({
          agreedWordingVersion: z.number().int().positive().nullable(),
          company: z.string().trim().min(1).nullable(),
        })
        .safeParse(input);
      if (!parsed.success) throw new AppError('invalid', 'Invalid inclusion input');
      const i = parsed.data;
      const entry = s.cached.get(a.id)?.find((e) => e.chat.key === chatKey);
      if (!entry) throw new AppError('invalid', 'List chats before inclusion');
      const chatId = s.db.tx(() => {
        const previous = s.db.get<{ decision: string }>(
          'SELECT decision FROM chat_selection WHERE account_id=? AND chat_key=?',
          a.id,
          chatKey,
        );
        if (previous?.decision === 'included') throw new AppError('conflict', 'Chat already included');
        const ch = s.db.get<{ withdrawn_at: string | null }>(
          'SELECT withdrawn_at FROM chat WHERE channel=? AND chat_key=?',
          a.channel,
          chatKey,
        );
        const last = s.db.get<{ kind: string }>(
          'SELECT kind FROM chat_agreement WHERE account_id=? AND channel=? AND chat_key=? ORDER BY id DESC LIMIT 1',
          a.id,
          a.channel,
          chatKey,
        );
        const required =
          getSetting<boolean>(s.db, 'require_agreement') ||
          last?.kind === 'withdrawn' ||
          previous?.decision === 'withdrawn' ||
          ch?.withdrawn_at != null;
        if (required && i.agreedWordingVersion !== agreementWording().version)
          throw new AppError('invalid', 'Statement of agreement required');
        if (required) agree(s, a, chatKey);
        const companyId = i.company === null ? null : ensureCompany(ctx, i.company);
        s.db.run(
          'INSERT INTO chat(channel,chat_key,kind,title,named_company_id,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(channel,chat_key) DO UPDATE SET title=excluded.title,withdrawn_at=NULL,withdrawn_by=NULL,named_company_id=coalesce(excluded.named_company_id,chat.named_company_id)',
          a.channel,
          chatKey,
          entry.chat.kind,
          entry.chat.title,
          companyId,
          s.now().toISOString(),
        );
        const id = s.db.get<{ id: Id }>('SELECT id FROM chat WHERE channel=? AND chat_key=?', a.channel, chatKey)?.id;
        if (id === undefined) throw new AppError('invalid', 'Missing included chat');
        s.db.run(
          "INSERT INTO chat_selection(account_id,chat_key,decision,decided_at) VALUES (?,?,'included',?) ON CONFLICT(account_id,chat_key) DO UPDATE SET decision='included',decided_at=excluded.decided_at",
          a.id,
          chatKey,
          s.now().toISOString(),
        );
        // This persisted hold precedes any asynchronous queue wait, even inside a caller transaction.
        s.db.run(
          "INSERT INTO account_chat(account_id,chat_id,native_chat_id,sync_state,sync_after,sync_since,sync_limit,sync_origin_state,sync_gap_from) VALUES (?,?,?,'syncing',NULL,?,200,'queued',NULL)",
          a.id,
          id,
          entry.chat.nativeId,
          new Date(s.now().getTime() - 7 * 86400000).toISOString(),
        );
        if (companyId !== null && entry.chat.kind === 'direct')
          for (const p of s.db.all<{ contact_id: Id }>(
            'SELECT DISTINCT i.contact_id FROM chat_participant cp JOIN identity i ON i.id=cp.identity_id WHERE cp.chat_id=? AND i.contact_id IS NOT NULL',
            id,
          ))
            setContactCompany(
              ctx,
              p.contact_id,
              { company: { id: companyId }, evidenceMessageIds: [] },
              { setBy: 'human' },
            );
        record(ctx, {
          action: 'chat.include',
          subjectKind: 'chat',
          subjectId: id,
          after: { accountId: a.id, companyId, agreedWordingVersion: required ? agreementWording().version : null },
        });
        record(ctx, {
          action: 'chat.sync_queue',
          subjectKind: 'chat',
          subjectId: id,
          after: { accountId: a.id, queuedAt: s.now().toISOString() },
        });
        return id;
      });
      scheduler.schedule(a.id, chatId, true);
    },
    excludeChat(ctx, accountId, chatKey) {
      const a = s.owner(ctx, accountId);
      if (!z.string().min(1).safeParse(chatKey).success) throw new AppError('invalid', 'Invalid chat key');
      const chatId = s.db.tx(() => {
        const ch = s.db.get<{ id: Id }>('SELECT id FROM chat WHERE channel=? AND chat_key=?', a.channel, chatKey);
        const selection = s.db.get<{ decision: string }>(
          'SELECT decision FROM chat_selection WHERE account_id=? AND chat_key=?',
          a.id,
          chatKey,
        );
        if (selection?.decision === 'withdrawn')
          throw new AppError('conflict', 'Chat withdrawn; fresh agreement required');
        if (!ch && !s.cached.get(a.id)?.some((e) => e.chat.key === chatKey))
          throw new AppError('not_found', 'Chat not listed');
        s.db.run(
          "INSERT INTO chat_selection(account_id,chat_key,decision,decided_at) VALUES (?,?,'excluded',?) ON CONFLICT(account_id,chat_key) DO UPDATE SET decision='excluded',decided_at=excluded.decided_at",
          a.id,
          chatKey,
          s.now().toISOString(),
        );
        if (ch) {
          clearPending(s.system, a.id, ch.id);
          s.db.run('DELETE FROM account_chat WHERE account_id=? AND chat_id=?', a.id, ch.id);
        }
        record(ctx, {
          action: 'chat.exclude',
          subjectKind: 'chat',
          subjectId: ch?.id ?? null,
          after: { accountId: a.id },
        });
        return ch?.id;
      });
      if (chatId !== undefined) scheduler.cancel(a.id, chatId);
    },
    confirmAgreement(ctx, accountId, chatId, i) {
      const a = s.owner(ctx, accountId);
      if (!z.strictObject({ agreedWordingVersion: z.literal(agreementWording().version) }).safeParse(i).success)
        throw new AppError('invalid', 'Statement of agreement required');
      s.db.tx(() => {
        const ch = selected(s, a, chatId);
        agree(s, a, ch.chat_key);
        s.db.run('UPDATE account_chat SET agreement_stale_since=NULL WHERE account_id=? AND chat_id=?', a.id, chatId);
        record(ctx, {
          action: 'chat.agree',
          subjectKind: 'chat',
          subjectId: chatId,
          after: { accountId: a.id, agreedWordingVersion: i.agreedWordingVersion },
        });
      });
    },
    markWithdrawn(ctx, accountId, chatId) {
      const a = s.owner(ctx, accountId);
      const result = s.db.tx(() => {
        const chat = selected(s, a, chatId);
        const owners = s.db.all<{ id: Id; teammate_id: Id }>(
          'SELECT id,teammate_id FROM channel_account WHERE channel=? ORDER BY id',
          a.channel,
        );
        for (const other of owners) {
          const included =
            s.db.get<{ decision: string }>(
              'SELECT decision FROM chat_selection WHERE account_id=? AND chat_key=?',
              other.id,
              chat.chat_key,
            )?.decision === 'included';
          if (included)
            s.db.run(
              "INSERT INTO chat_agreement(account_id,channel,chat_key,kind,teammate_id,at) VALUES (?,?,?,'withdrawn',?,?)",
              other.id,
              a.channel,
              chat.chat_key,
              other.teammate_id,
              s.now().toISOString(),
            );
          s.db.run(
            "INSERT INTO chat_selection(account_id,chat_key,decision,decided_at) VALUES (?,?,'withdrawn',?) ON CONFLICT(account_id,chat_key) DO UPDATE SET decision='withdrawn',decided_at=excluded.decided_at",
            other.id,
            chat.chat_key,
            s.now().toISOString(),
          );
        }
        s.db.run(
          "UPDATE chat SET title='',withdrawn_at=?,withdrawn_by=? WHERE id=?",
          s.now().toISOString(),
          a.teammate_id,
          chatId,
        );
        // named_company_id intentionally remains for the later graph.forget callback.
        clearPending(s.system, null, chatId);
        s.db.run('DELETE FROM account_chat WHERE chat_id=?', chatId);
        s.db.run('DELETE FROM chat_gap WHERE chat_id=?', chatId);
        return {
          owners,
          ids: s.db.all<{ id: Id }>('SELECT id FROM message WHERE chat_id=? ORDER BY id', chatId).map((m) => m.id),
        };
      });
      for (const other of result.owners) scheduler.cancel(other.id, chatId);
      // Purge owns message deletion/redaction and the ONE final chat.withdraw action entry.
      return result.ids;
    },
    setIncludeAll(ctx, accountId, _on) {
      s.owner(ctx, accountId);
      throw new AppError('invalid', 'not built: setIncludeAll');
    },
    startImport(ctx, accountId, _chatId, _i) {
      s.owner(ctx, accountId);
      throw new AppError('invalid', 'not built: startImport');
    },
  };
}
