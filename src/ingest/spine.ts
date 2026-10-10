import { z } from 'zod';
import { getSetting, open, seal } from '../auth/index.ts';
import type {
  AppConfig,
  ChatListEntry,
  ChatListing,
  Connector,
  ConnectorFactory,
  Ctx,
  Db,
  Host,
  Id,
  OpLog,
} from '../contracts/index.ts';
import { AppError, ConnectorEventSchema, LoginStepSchema } from '../contracts/index.ts';
import { bindSelfIdentity, ensureCompany, setContactCompany } from '../graph/index.ts';
import { record } from '../log/index.ts';
import { storeOnce } from './host/store-once.ts';

// Public agreementWording remains not-built; this fixed statement is used only by admitted inclusion.
const wording =
  "The people in this chat have agreed that its messages may be stored on my team's board, read by my teammates, and analysed by software. I will withdraw the chat if any of them withdraws that agreement, or if someone joins who has not agreed.";
interface Account {
  id: Id;
  teammate_id: Id;
  channel: string;
  state: string;
  session_sealed: Uint8Array | null;
}
export function createHost(deps: {
  db: Db;
  now(): Date;
  sleep(ms: number): Promise<void>;
  connectors: ConnectorFactory[];
  config: AppConfig;
  oplog: OpLog;
}): Host {
  const { db, now } = deps;
  const live = new Map<Id, Connector>();
  const cached = new Map<Id, ChatListEntry[]>();
  const queue: { accountId: Id; chatId: Id; entry: ChatListEntry; ctx: Ctx }[] = [];
  let settling: Promise<void> | null = null;
  let stopped = false;
  const system: Ctx = { db, now, actor: { kind: 'system' }, canReadText: true };
  function account(id: Id): Account {
    const r = db.get<Account>('SELECT * FROM channel_account WHERE id=?', id);
    if (!r) throw new AppError('not_found', 'Account not found');
    return r;
  }
  function owner(ctx: Ctx, id: Id): Account {
    const r = account(id);
    if (ctx.actor.kind !== 'teammate' || ctx.actor.id !== r.teammate_id)
      throw new AppError('forbidden', 'Account owner required');
    return r;
  }
  function factory(channel: string): ConnectorFactory {
    const f = deps.connectors.find((c) => c.channel === channel);
    if (!f) throw new AppError('invalid', 'Unknown channel');
    return f;
  }
  function connector(a: Account): Connector {
    const existing = live.get(a.id);
    if (existing) return existing;
    const c = factory(a.channel).create({
      accountId: a.id,
      session: a.session_sealed === null ? null : open(deps.config.secretKey, a.session_sealed),
      config: deps.config.connectors[a.channel] ?? {},
      now,
      sleep: deps.sleep,
      log: deps.oplog,
      saveSession(session) {
        db.tx(() => {
          db.run(
            'UPDATE channel_account SET session_sealed=? WHERE id=?',
            session === null ? null : seal(deps.config.secretKey, session),
            a.id,
          );
        });
      },
    });
    live.set(a.id, c);
    return c;
  }
  async function startAccount(a: Account): Promise<void> {
    const c = connector(a);
    cached.set(a.id, await c.listChats());
    await c.start({
      async emit(value) {
        if (stopped) return;
        const parsed = ConnectorEventSchema.safeParse(value);
        if (!parsed.success) throw new AppError('invalid', 'Invalid connector event');
        const event = parsed.data;
        if (event.type === 'status') {
          if (event.state !== 'connected') throw new AppError('invalid', 'not built: reconnect');
          return;
        }
        if (event.type !== 'message') throw new AppError('invalid', `not built: ${event.type}`);
        const listings = cached.get(a.id) ?? [];
        const entry = listings.find((e) => e.chat.key === event.chat.key);
        if (entry) {
          entry.latestAt = event.message.sentAt;
          entry.latestCursor = event.message.cursor;
        } else listings.push({ chat: event.chat, latestAt: event.message.sentAt, latestCursor: event.message.cursor });
        cached.set(a.id, listings);
        const selected = db.get<{ decision: string }>(
          'SELECT decision FROM chat_selection WHERE account_id=? AND chat_key=?',
          a.id,
          event.chat.key,
        );
        if (selected?.decision !== 'included') return;
        const chat = db.get<{ id: Id }>(
          'SELECT id FROM chat WHERE channel=? AND chat_key=? AND withdrawn_at IS NULL',
          a.channel,
          event.chat.key,
        );
        if (!chat) return;
        storeOnce(system, a, chat.id, event.message, 'live');
      },
    });
  }
  const host: Host = {
    listChannels() {
      throw new AppError('invalid', 'not built: listChannels');
    },
    listAccounts() {
      throw new AppError('invalid', 'not built: listAccounts');
    },
    async beginLogin(ctx, channel, i) {
      if (ctx.actor.kind !== 'teammate') throw new AppError('forbidden', 'Teammate required');
      if (!z.strictObject({ acknowledgedNoticeVersion: z.number().int().positive().nullable() }).safeParse(i).success)
        throw new AppError('invalid', 'Invalid login input');
      const f = factory(channel);
      const notice = f.loginNotice(deps.config.connectors[channel] ?? {});
      if (notice && i.acknowledgedNoticeVersion !== notice.version)
        throw new AppError('invalid', 'Login notice acknowledgement required');
      const id = db.tx(() => {
        if (
          db.get(
            'SELECT id FROM channel_account WHERE teammate_id=? AND channel=?',
            ctx.actor.kind === 'teammate' ? ctx.actor.id : null,
            channel,
          )
        )
          throw new AppError('conflict', 'Account exists');
        const id = db.run(
          "INSERT INTO channel_account(teammate_id,channel,state,created_at) VALUES (?,?,'login',?)",
          ctx.actor.kind === 'teammate' ? ctx.actor.id : null,
          channel,
          now().toISOString(),
        ).lastInsertRowid;
        record(ctx, {
          action: 'account.acknowledge',
          subjectKind: 'account',
          subjectId: id,
          after: { noticeVersion: notice?.version ?? null },
        });
        return id;
      });
      return { accountId: id, step: await connector(account(id)).login(null) };
    },
    async continueLogin(ctx, accountId, input) {
      const a = owner(ctx, accountId);
      const step = LoginStepSchema.parse(await connector(a).login(input));
      if (step.kind === 'done')
        db.tx(() => {
          const identityId = bindSelfIdentity(ctx, { channel: a.channel, ...step.self, teammateId: a.teammate_id });
          db.run("UPDATE channel_account SET self_identity_id=?,state='connected' WHERE id=?", identityId, a.id);
          record(ctx, { action: 'account.connect', subjectKind: 'account', subjectId: a.id, after: { identityId } });
        });
      return step;
    },
    disconnect() {
      throw new AppError('invalid', 'not built: disconnect');
    },
    async listChats(ctx, accountId) {
      const a = owner(ctx, accountId);
      const entries = await connector(a).listChats();
      cached.set(a.id, entries);
      return entries.map((e): ChatListing => {
        const selected = db.get<{ decision: ChatListing['decision'] }>(
          'SELECT decision FROM chat_selection WHERE account_id=? AND chat_key=?',
          a.id,
          e.chat.key,
        );
        const ch = db.get<{ id: Id; withdrawn_at: string | null; withdrawnBy: string | null }>(
          'SELECT ch.*,t.display_name AS withdrawnBy FROM chat ch LEFT JOIN teammate t ON t.id=ch.withdrawn_by WHERE ch.channel=? AND ch.chat_key=?',
          a.channel,
          e.chat.key,
        );
        const ac = ch
          ? db.get<{ agreement_stale_since: string | null }>(
              'SELECT agreement_stale_since FROM account_chat WHERE account_id=? AND chat_id=?',
              a.id,
              ch.id,
            )
          : undefined;
        return {
          key: e.chat.key,
          chatId: ch?.id ?? null,
          kind: e.chat.kind,
          title: e.chat.title,
          latestAt: e.latestAt,
          decision: selected?.decision ?? 'undecided',
          agreementOutOfDate: ac?.agreement_stale_since != null,
          withdrawnBy: ch?.withdrawnBy ?? null,
          withdrawnAt: ch?.withdrawn_at ?? null,
        };
      });
    },
    chatCounts(ctx) {
      if (ctx.actor.kind !== 'teammate') throw new AppError('forbidden', 'Teammate required');
      const accounts = db.all<Account>(
        'SELECT * FROM channel_account WHERE teammate_id=? AND state<>?',
        ctx.actor.id,
        'removed',
      );
      const known = accounts.every((a) => cached.has(a.id));
      const since = new Date(now().getTime() - 7 * 86400000).toISOString();
      return {
        connected: accounts.some((a) => a.state === 'connected' && !stopped),
        undecidedRecent: known
          ? accounts.reduce(
              (n, a) =>
                n +
                (cached.get(a.id) ?? []).filter(
                  (e) =>
                    e.latestAt !== null &&
                    e.latestAt >= since &&
                    !db.get('SELECT decision FROM chat_selection WHERE account_id=? AND chat_key=?', a.id, e.chat.key),
                ).length,
              0,
            )
          : null,
        agreementOutOfDate:
          db.get<{ n: number }>(
            'SELECT count(*) AS n FROM account_chat ac JOIN channel_account a ON a.id=ac.account_id WHERE a.teammate_id=? AND ac.agreement_stale_since IS NOT NULL',
            ctx.actor.id,
          )?.n ?? 0,
      };
    },
    includeChat(ctx, accountId, chatKey, i) {
      const a = owner(ctx, accountId);
      if (
        !z
          .strictObject({
            agreedWordingVersion: z.number().int().positive().nullable(),
            company: z.string().min(1).nullable(),
          })
          .safeParse(i).success
      )
        throw new AppError('invalid', 'Invalid inclusion input');
      const entry = cached.get(a.id)?.find((e) => e.chat.key === chatKey);
      if (!entry) throw new AppError('invalid', 'List chats before inclusion');
      const chatId = db.tx(() => {
        const previous = db.get<{ decision: string }>(
          'SELECT decision FROM chat_selection WHERE account_id=? AND chat_key=?',
          a.id,
          chatKey,
        );
        if (previous?.decision === 'included') throw new AppError('conflict', 'Chat already included');
        const lastAgreement = db.get<{ kind: string }>(
          'SELECT kind FROM chat_agreement WHERE account_id=? AND chat_key=? ORDER BY id DESC LIMIT 1',
          a.id,
          chatKey,
        );
        const agreed = getSetting<boolean>(db, 'require_agreement') || lastAgreement?.kind === 'withdrawn';
        if (agreed && i.agreedWordingVersion !== 1) throw new AppError('invalid', 'Statement of agreement required');
        if (agreed)
          db.run(
            "INSERT INTO chat_agreement(account_id,channel,chat_key,kind,teammate_id,at,wording_version,wording) VALUES (?,?,?,'confirmed',?,?,1,?)",
            a.id,
            a.channel,
            chatKey,
            a.teammate_id,
            now().toISOString(),
            wording,
          );
        const companyId = i.company === null ? null : ensureCompany(ctx, i.company);
        db.run(
          'INSERT INTO chat(channel,chat_key,kind,title,named_company_id,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(channel,chat_key) DO UPDATE SET withdrawn_at=NULL,withdrawn_by=NULL,title=excluded.title,named_company_id=coalesce(excluded.named_company_id,chat.named_company_id)',
          a.channel,
          chatKey,
          entry.chat.kind,
          entry.chat.title,
          companyId,
          now().toISOString(),
        );
        const id = db.get<{ id: Id }>('SELECT id FROM chat WHERE channel=? AND chat_key=?', a.channel, chatKey)
          ?.id as Id;
        db.run(
          "INSERT INTO chat_selection(account_id,chat_key,decision,decided_at) VALUES (?,?,'included',?) ON CONFLICT(account_id,chat_key) DO UPDATE SET decision='included',decided_at=excluded.decided_at",
          a.id,
          chatKey,
          now().toISOString(),
        );
        db.run(
          "INSERT INTO account_chat(account_id,chat_id,native_chat_id,sync_state,sync_since,sync_limit) VALUES (?,?,?,'syncing',?,200)",
          a.id,
          id,
          entry.chat.nativeId,
          new Date(now().getTime() - 7 * 86400000).toISOString(),
        );
        if (companyId !== null && entry.chat.kind === 'direct')
          for (const p of db.all<{ contact_id: Id }>(
            'SELECT i.contact_id FROM chat_participant cp JOIN identity i ON i.id=cp.identity_id WHERE cp.chat_id=? AND i.contact_id IS NOT NULL',
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
          after: { accountId: a.id, companyId, agreedWordingVersion: agreed ? 1 : null },
        });
        return id;
      });
      queue.push({ accountId, chatId, entry, ctx });
    },
    excludeChat() {
      throw new AppError('invalid', 'not built: excludeChat');
    },
    confirmAgreement() {
      throw new AppError('invalid', 'not built: confirmAgreement');
    },
    markWithdrawn() {
      throw new AppError('invalid', 'not built: markWithdrawn');
    },
    setIncludeAll() {
      throw new AppError('invalid', 'not built: setIncludeAll');
    },
    startImport() {
      throw new AppError('invalid', 'not built: startImport');
    },
    async startAll() {
      stopped = false;
      await Promise.all(
        db
          .all<Account>("SELECT * FROM channel_account WHERE state IN ('connected','disconnected')")
          .map((a) => startAccount(a)),
      );
    },
    async stopAll() {
      stopped = true;
      await Promise.all(Array.from(live.values(), (c) => c.stop()));
      if (settling) await settling;
    },
    async settle() {
      if (settling) return settling;
      settling = (async () => {
        while (queue.length) {
          const job = queue.shift();
          if (!job) break;
          const a = account(job.accountId);
          const state = db.get<{ sync_since: string }>(
            'SELECT sync_since FROM account_chat WHERE account_id=? AND chat_id=?',
            a.id,
            job.chatId,
          );
          if (!state) throw new AppError('invalid', 'Missing inclusion state');
          for await (const page of connector(a).fetchHistory({
            chat: job.entry.chat,
            after: null,
            since: state.sync_since,
            limit: 200,
            resume: null,
          })) {
            for (const m of page.messages) storeOnce(system, a, job.chatId, m, 'history');
          }
          db.tx(() => {
            db.run(
              "UPDATE account_chat SET sync_state='idle',sync_since=NULL,sync_limit=NULL,sync_after=NULL,sync_resume=NULL,sync_newest=NULL,sync_failed_since=NULL WHERE account_id=? AND chat_id=?",
              a.id,
              job.chatId,
            );
          });
        }
      })();
      try {
        await settling;
      } finally {
        settling = null;
      }
    },
  };
  return host;
}
