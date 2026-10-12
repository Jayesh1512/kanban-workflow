import { listTeammates, open, seal } from '../../auth/index.ts';
import type {
  AppConfig,
  ChatListEntry,
  Connector,
  ConnectorFactory,
  Ctx,
  Db,
  Id,
  OpLog,
} from '../../contracts/index.ts';
import { ActorSchema, AppError, IdSchema } from '../../contracts/index.ts';
import { record } from '../../log/index.ts';

export interface Account {
  id: Id;
  teammate_id: Id;
  channel: string;
  state: 'login' | 'connected' | 'disconnected' | 'auth_lost' | 'removed';
  self_identity_id: Id | null;
  session_sealed: Uint8Array | null;
}
export interface Runtime {
  connector: Connector;
  epoch: number;
  accepting: boolean;
  saving: boolean;
  starting: boolean;
  fault: boolean;
  io: Promise<unknown>;
  lifecycle: Promise<unknown>;
  lastCatchup: number | null;
  catchup: Promise<void> | null;
  cancelCatchup: (() => void) | null;
}
export function createState(deps: {
  db: Db;
  now(): Date;
  sleep(ms: number): Promise<void>;
  connectors: ConnectorFactory[];
  config: AppConfig;
  oplog: OpLog;
}) {
  const { db, now } = deps;
  const system: Ctx = { db, now, actor: { kind: 'system' }, canReadText: true };
  const live = new Map<Id, Runtime>();
  const cached = new Map<Id, ChatListEntry[]>();
  let stopped = false;
  function human(ctx: Ctx): Id {
    if (ctx.db !== db || !ActorSchema.safeParse(ctx.actor).success)
      throw new AppError('forbidden', 'Active account owner required');
    // Use the reviewed auth boundary; a remembered actor cannot outlive removal.
    listTeammates(ctx);
    if (ctx.actor.kind !== 'teammate') throw new AppError('forbidden', 'Active account owner required');
    return ctx.actor.id;
  }
  function account(id: Id): Account {
    if (!IdSchema.safeParse(id).success) throw new AppError('invalid', 'Invalid account id');
    const a = db.get<Account>('SELECT * FROM channel_account WHERE id=?', id);
    if (!a) throw new AppError('not_found', 'Account not found');
    return a;
  }
  function active(id: Id): boolean {
    return Boolean(
      db.get(
        "SELECT a.id FROM channel_account a JOIN teammate t ON t.id=a.teammate_id WHERE a.id=? AND a.state NOT IN ('removed','auth_lost') AND t.removed_at IS NULL",
        id,
      ),
    );
  }
  function owner(ctx: Ctx, id: Id, allowRemoved = false): Account {
    const teammateId = human(ctx);
    const a = account(id);
    if (a.teammate_id !== teammateId) throw new AppError('forbidden', 'Account owner required');
    if (!allowRemoved && a.state === 'removed') throw new AppError('forbidden', 'Account removed');
    return a;
  }
  function factory(channel: string): ConnectorFactory {
    const f = deps.connectors.find((c) => c.channel === channel);
    if (!f) throw new AppError('invalid', 'Unknown channel');
    return f;
  }
  function runtime(a: Account): Runtime {
    const previous = live.get(a.id);
    if (previous) return previous;
    let rt: Runtime;
    const connector = factory(a.channel).create({
      accountId: a.id,
      session: a.session_sealed === null ? null : open(deps.config.secretKey, a.session_sealed),
      config: deps.config.connectors[a.channel] ?? {},
      now,
      sleep: deps.sleep,
      log: deps.oplog,
      saveSession(session) {
        if (live.get(a.id) !== rt) throw new AppError('forbidden', 'Account session no longer active');
        db.tx(() => {
          const current = account(a.id);
          // null is always allowed for teardown; revoked/old instances cannot restore access.
          if (session !== null && (!rt.saving || live.get(a.id) !== rt || !active(a.id)))
            throw new AppError('forbidden', 'Account session no longer active');
          db.run(
            'UPDATE channel_account SET session_sealed=? WHERE id=?',
            session === null ? null : seal(deps.config.secretKey, session),
            current.id,
          );
        }); // Normal return means the ENTIRE opaque string was atomically replaced.
      },
    });
    rt = {
      connector,
      epoch: 0,
      accepting: false,
      saving: true,
      starting: false,
      fault: false,
      io: Promise.resolve(),
      lifecycle: Promise.resolve(),
      lastCatchup: null,
      catchup: null,
      cancelCatchup: null,
    };
    live.set(a.id, rt);
    return rt;
  }
  function serial<T>(rt: Runtime, run: () => Promise<T>): Promise<T> {
    const p = rt.io.then(run);
    rt.io = p.catch(() => {}); // The caller receives the failure; the queue remains usable.
    return p;
  }
  function lifecycle<T>(rt: Runtime, run: () => Promise<T>): Promise<T> {
    const p = rt.lifecycle.then(run);
    rt.lifecycle = p.catch(() => {});
    return p;
  }
  function status(id: Id, next: Account['state']): void {
    db.tx(() => {
      const a = account(id);
      if (a.state === 'removed' || a.state === next) return;
      db.run('UPDATE channel_account SET state=? WHERE id=?', next, id);
      record(system, { action: 'account.connect', subjectKind: 'account', subjectId: id, after: { state: next } });
    });
  }
  return {
    ...deps,
    system,
    live,
    cached,
    human,
    account,
    active,
    owner,
    factory,
    runtime,
    serial,
    lifecycle,
    status,
    get stopped() {
      return stopped;
    },
    set stopped(value: boolean) {
      stopped = value;
    },
  };
}
export type State = ReturnType<typeof createState>;
