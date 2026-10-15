import { z } from 'zod';
import type { AgentWorkScope, Ctx, DecideInput, Id } from '../contracts/index.ts';
import { AppError, IdSchema } from '../contracts/index.ts';

// Internal current-spine provenance, stored inside its existing private decision
// JSON. Written by the host AFTER schema validation, never accepted from a model.
// It records full supplied context, not claimed citations or new public schemas.
const output = z.strictObject({ id: IdSchema, logId: IdSchema });
const contextSchema = z.strictObject({
  version: z.literal(1),
  messageIds: z.array(IdSchema),
  chatIds: z.array(IdSchema),
  unknown: z.boolean(),
  cards: z.array(output),
  roles: z.array(output),
});
type OutputContext = z.infer<typeof contextSchema>;
function storedContext(raw: string): OutputContext | null {
  try {
    const parsed = contextSchema.safeParse(JSON.parse(raw).__withdrawalContext);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function currentContext(ctx: Ctx, kind: 'card' | 'contact', id: Id): OutputContext | null {
  const rows = ctx.db.all<{ id: Id; after: string | null; raw: string | null }>(
    `SELECT a.id,a.after,d.raw FROM action_log a LEFT JOIN decision d ON d.id=a.decision_id
     WHERE a.subject_kind=? AND a.subject_id=? AND
       ((?='card' AND a.action IN ('card.create','card.update')) OR
        (?='contact' AND a.action='contact.set_role')) ORDER BY a.id DESC`,
    kind,
    id,
    kind,
    kind,
  );
  for (const row of rows) {
    const context = row.raw === null ? null : storedContext(row.raw);
    const pointer = context?.[kind === 'card' ? 'cards' : 'roles'].some((o) => o.id === id && o.logId === row.id);
    if (row.after === null) return pointer ? context : null;
    const value: unknown = JSON.parse(row.after);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const after = value as Record<string, unknown>;
    if (kind === 'card') {
      if (!('title' in after) && !('summary' in after)) continue;
      const current = ctx.db.get<{ title: string; summary: string }>('SELECT title,summary FROM card WHERE id=?', id);
      if (after.title !== current?.title || after.summary !== current?.summary) return null;
    } else {
      const current = ctx.db.get<{ role_category: string; deals_about: string }>(
        'SELECT role_category,deals_about FROM contact WHERE id=?',
        id,
      );
      if (after.category !== current?.role_category || after.dealsAbout !== current?.deals_about) return null;
    }
    return pointer ? context : null;
  }
  return null;
}

/** Capture transitive context BEFORE applying the new output. Unknown legacy
 * generated input remains unknown even when it has apparently unrelated links. */
export function captureOutputContext(ctx: Ctx, input: DecideInput, scope: AgentWorkScope): OutputContext {
  const messages = new Set(scope.messageIds),
    chats = new Set(scope.chatIds);
  let unknown = input.proposals.length > 0;
  function inherit(context: OutputContext | null): void {
    if (!context || context.unknown) unknown = true;
    for (const id of context?.messageIds ?? []) messages.add(id);
    for (const id of context?.chatIds ?? []) chats.add(id);
  }
  for (const card of input.cards) {
    const current = ctx.db.get<{ text_set_by: string; needs_text: number }>(
      'SELECT text_set_by,needs_text FROM card WHERE id=?',
      card.id,
    );
    if (current?.text_set_by === 'agent' && !current.needs_text) inherit(currentContext(ctx, 'card', card.id));
  }
  for (const participant of input.participants) {
    const current = ctx.db.get<{ role_set_by: string }>(
      'SELECT role_set_by FROM contact WHERE id=?',
      participant.contactId,
    );
    if (current?.role_set_by === 'agent' && (participant.roleCategory !== 'unknown' || participant.dealsAbout))
      inherit(currentContext(ctx, 'contact', participant.contactId));
  }
  return {
    version: 1,
    messageIds: [...messages].sort((a, b) => a - b),
    chatIds: [...chats].sort((a, b) => a - b),
    unknown,
    cards: [],
    roles: [],
  };
}

/** Bind only ACTUAL field writes from the actual owner callbacks. No copied text
 * is added to provenance; log identity prevents attachment/citation inference. */
export function bindOutputContext(ctx: Ctx, decisionId: Id, context: OutputContext): void {
  for (const row of ctx.db.all<{ id: Id; action: string; subject_id: Id; after: string }>(
    'SELECT id,action,subject_id,after FROM action_log WHERE decision_id=? AND after IS NOT NULL ORDER BY id',
    decisionId,
  )) {
    const value: unknown = JSON.parse(row.after);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const after = value as Record<string, unknown>;
    if ((row.action === 'card.create' || row.action === 'card.update') && 'title' in after && 'summary' in after)
      context.cards.push({ id: row.subject_id, logId: row.id });
    if (row.action === 'contact.set_role') context.roles.push({ id: row.subject_id, logId: row.id });
  }
  const row = ctx.db.get<{ raw: string }>('SELECT raw FROM decision WHERE id=?', decisionId);
  ctx.db.run(
    'UPDATE decision SET raw=? WHERE id=?',
    JSON.stringify({ ...JSON.parse(row?.raw ?? '{}'), __withdrawalContext: context }),
    decisionId,
  );
}

/** Discover ALL live generated outputs before any raw/review/log provenance is
 * destroyed. Unknown legacy values are unsafe regardless of their citations. */
export function discoverGeneratedOutputs(ctx: Ctx, messageIds: Id[]): { cardIds: Id[]; contactIds: Id[] } {
  if (!messageIds.length) return { cardIds: [], contactIds: [] };
  const chats = new Set(
    ctx.db
      .all<{ chat_id: Id }>(
        'SELECT DISTINCT chat_id FROM message WHERE id IN (SELECT value FROM json_each(?))',
        JSON.stringify(messageIds),
      )
      .map((r) => r.chat_id),
  );
  function unsafe(kind: 'card' | 'contact', id: Id): boolean {
    const context = currentContext(ctx, kind, id);
    return (
      !context ||
      context.unknown ||
      context.messageIds.some((id) => messageIds.includes(id)) ||
      context.chatIds.some((id) => chats.has(id))
    );
  }
  return {
    cardIds: ctx.db
      .all<{ id: Id }>("SELECT id FROM card WHERE text_set_by='agent' ORDER BY id")
      .filter((r) => unsafe('card', r.id))
      .map((r) => r.id),
    contactIds: ctx.db
      .all<{ id: Id }>(
        "SELECT id FROM contact WHERE role_set_by='agent' AND (role_category<>'unknown' OR deals_about<>'') ORDER BY id",
      )
      .filter((r) => unsafe('contact', r.id))
      .map((r) => r.id),
  };
}

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
    for (const row of ctx.db.all<{ id: Id; raw: string }>('SELECT id,raw FROM decision')) {
      const context = storedContext(row.raw);
      // Keep only content-free complete provenance for unaffected outputs. This
      // prevents a second withdrawal from turning proven support into legacy.
      const safe =
        context &&
        !context.unknown &&
        !context.messageIds.some((id) => messageIds.includes(id)) &&
        !context.chatIds.some((id) => ctx.db.get('SELECT id FROM chat WHERE id=? AND withdrawn_at IS NOT NULL', id));
      ctx.db.run(
        "UPDATE decision SET raw=?,reason='' WHERE id=?",
        safe ? JSON.stringify({ __withdrawalContext: context }) : '{}',
        row.id,
      );
    }
    ctx.db.run('DELETE FROM movement_decision');
    ctx.db.run('DELETE FROM review_item');
    // Legacy mentions also lack context support; their trigger FK is not proof
    // that a copied company name came only from that triggering message.
    ctx.db.run('DELETE FROM pending_mention');
    return { decisionIds, reviewItemIds };
  });
}
