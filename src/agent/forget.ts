import type { Ctx, Id } from '../contracts/index.ts';
import { AppError, IdSchema } from '../contracts/index.ts';

/** Purge-only erasure of the CURRENT spine's stored derivatives. Its raw output
 * and historical reviews have no complete durable input-context provenance.
 * A review_message link certifies a trigger, not every copied supporting fact.
 * Conservatively discard those opaque copies, including mixed/settled reviews,
 * rather than guessing that an unrelated trigger proves unrelated content. */
export function forgetMessages(ctx: Ctx, messageIds: Id[]): { decisionIds: Id[]; reviewItemIds: Id[] } {
  if (messageIds.some((id) => !IdSchema.safeParse(id).success))
    throw new AppError('invalid', 'Invalid forget message ids');
  if (!messageIds.length) return { decisionIds: [], reviewItemIds: [] };
  return ctx.db.tx(() => {
    // Do this BEFORE deleting any provenance. Include disappeared supplied IDs
    // and all surviving context, because legacy context support is incomplete.
    const scope = [...new Set([...messageIds, ...ctx.db.all<{ id: Id }>('SELECT id FROM message').map((r) => r.id)])];
    ctx.db.invalidateAgentWork({ chatIds: [], messageIds: scope });
    const decisionIds = ctx.db.all<{ id: Id }>('SELECT id FROM decision ORDER BY id').map((r) => r.id);
    const reviewItemIds = ctx.db.all<{ id: Id }>('SELECT id FROM review_item ORDER BY id').map((r) => r.id);
    // Keep processed-version/decision uniqueness fences. Deleting surviving
    // decisions would allow stale reprocessing; only their copied payload dies.
    ctx.db.run("UPDATE decision SET raw='{}',reason='' WHERE raw<>'{}' OR reason<>''");
    ctx.db.run('DELETE FROM movement_decision');
    ctx.db.run('DELETE FROM review_item');
    // Legacy mentions also lack context support; their trigger FK is not proof
    // that a copied company name came only from that triggering message.
    ctx.db.run('DELETE FROM pending_mention');
    return { decisionIds, reviewItemIds };
  });
}
