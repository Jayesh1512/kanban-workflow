import { z } from 'zod';
import type { Host } from '../../contracts/index.ts';
import { AppError } from '../../contracts/index.ts';
import { record } from '../../log/index.ts';
import type { createAccounts } from './accounts.ts';
import { cleanup } from './cleanup.ts';
import { counts, listAccounts, refreshListing, showListing } from './listing.ts';
import type { Scheduler } from './scheduler.ts';
import type { Account, State } from './state.ts';

export function accountMethods(
  s: State,
  accounts: ReturnType<typeof createAccounts>,
  scheduler: Scheduler,
): Pick<
  Host,
  'listChannels' | 'listAccounts' | 'beginLogin' | 'continueLogin' | 'disconnect' | 'listChats' | 'chatCounts'
> {
  return {
    listChannels() {
      return s.connectors.map((f) => ({
        channel: f.channel,
        label: f.label,
        loginNotice: f.loginNotice(s.config.connectors[f.channel] ?? {}),
      }));
    },
    listAccounts: (ctx) => listAccounts(s, ctx),
    async beginLogin(ctx, channel, i) {
      const cleanupDeadline = s.now().getTime() + 5000;
      const teammateId = s.human(ctx);
      if (!z.strictObject({ acknowledgedNoticeVersion: z.number().int().positive().nullable() }).safeParse(i).success)
        throw new AppError('invalid', 'Invalid login input');
      const notice = s.factory(channel).loginNotice(s.config.connectors[channel] ?? {});
      if (notice && notice.version !== i.acknowledgedNoticeVersion)
        throw new AppError('invalid', 'Login notice acknowledgement required');
      const id = s.db.tx(() => {
        const previous = s.db.get<Account>(
          'SELECT * FROM channel_account WHERE teammate_id=? AND channel=?',
          teammateId,
          channel,
        );
        const id =
          previous?.id ??
          s.db.run(
            "INSERT INTO channel_account(teammate_id,channel,state,created_at) VALUES (?,?,'login',?)",
            teammateId,
            channel,
            s.now().toISOString(),
          ).lastInsertRowid;
        s.db.run("UPDATE channel_account SET state='login' WHERE id=?", id);
        record(ctx, {
          action: 'account.acknowledge',
          subjectKind: 'account',
          subjectId: id,
          after: { noticeVersion: notice?.version ?? null },
        });
        return id;
      });
      const rt = s.live.get(id);
      if (rt?.accepting || rt?.fault) {
        rt.accepting = false;
        rt.epoch++;
        scheduler.cancel(id);
        try {
          await cleanup(s, () => rt.connector.stop(), cleanupDeadline);
        } finally {
          rt.saving = false;
          s.live.delete(id);
        }
      }
      return { accountId: id, step: await accounts.login(ctx, s.account(id), null) };
    },
    async continueLogin(ctx, accountId, input) {
      const a = s.owner(ctx, accountId);
      if (a.state !== 'login') throw new AppError('invalid', 'Begin account login first');
      if (!z.record(z.string(), z.string()).safeParse(input).success)
        throw new AppError('invalid', 'Invalid login input');
      const notice = s.factory(a.channel).loginNotice(s.config.connectors[a.channel] ?? {});
      if (
        notice &&
        !s.db.get(
          "SELECT id FROM action_log WHERE action='account.acknowledge' AND subject_id=? AND actor_kind='teammate' AND actor_id=? AND json_extract(after,'$.noticeVersion')=? ORDER BY id DESC LIMIT 1",
          a.id,
          a.teammate_id,
          notice.version,
        )
      )
        throw new AppError('invalid', 'Login notice acknowledgement required');
      return accounts.login(ctx, a, input);
    },
    disconnect: accounts.disconnect,
    async listChats(ctx, accountId) {
      const a = s.owner(ctx, accountId);
      if (!s.active(a.id) || a.state === 'login') throw new AppError('unauthenticated', 'Account not connected');
      const rt = s.runtime(a);
      const generation = rt.epoch;
      await refreshListing(s, a, rt, () => rt.epoch === generation && s.active(a.id));
      s.owner(ctx, accountId);
      return showListing(s, a);
    },
    chatCounts: (ctx) => counts(s, ctx),
  };
}
