import { z } from 'zod';
import type { AgentWorkScope, Ctx, DecideInput, Id } from '../contracts/index.ts';
import { AppError, IdSchema } from '../contracts/index.ts';

// Internal current-spine provenance, stored inside its existing private decision
// JSON. Written by the host AFTER schema validation, never accepted from a model.
// It records full supplied context, not claimed citations or new public schemas.
// v1 omitted company contributors and cannot certify existing output independence.
const output = z.strictObject({ id: IdSchema, logId: IdSchema });
const contextSchema = z.strictObject({
  version: z.literal(2),
  messageIds: z.array(IdSchema),
  chatIds: z.array(IdSchema),
  unknown: z.boolean(),
  cards: z.array(output),
  roles: z.array(output),
  companies: z.array(output).default([]),
  companyLinks: z.array(output.extend({ companyId: IdSchema })).default([]),
  cardCompanies: z.array(output.extend({ companyId: IdSchema })).default([]),
  references: z.array(output).default([]),
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

// Relationship evidence and freshness hashes are not producing-input support.
// These writes have no durable field pointer in legacy decisions. Use their
// actual, still-readable owner write when it matches; redacted/missing writes
// remain unknown. Never infer support from a current citation alone.
function relationshipContext(ctx: Ctx, kind: 'card' | 'contact', id: Id, companyId: Id): OutputContext | null {
  for (const row of ctx.db.all<{ id: Id; after: string | null; raw: string | null }>(
    `SELECT a.id,a.after,d.raw FROM action_log a LEFT JOIN decision d ON d.id=a.decision_id
     WHERE a.subject_kind=? AND a.subject_id=? AND
       ((?='card' AND a.action IN ('card.create','card.update')) OR
        (?='contact' AND a.action IN ('contact.set_company','contact.remove_company')))
     ORDER BY a.id DESC`,
    kind,
    id,
    kind,
    kind,
  )) {
    if (row.after === null) {
      const context = row.raw === null ? null : storedContext(row.raw);
      if (
        context?.[kind === 'card' ? 'cardCompanies' : 'companyLinks'].some(
          (o) => o.id === id && o.logId === row.id && o.companyId === companyId,
        )
      )
        return context;
      if (kind === 'contact' && context?.companyLinks.some((o) => o.id === id && o.logId === row.id)) continue;
      return null;
    }
    const value: unknown = JSON.parse(row.after);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const after = value as Record<string, unknown>;
    if (!('companyId' in after)) continue;
    if (kind === 'contact' && after.companyId !== companyId) continue;
    const context = row.raw === null ? null : storedContext(row.raw);
    return after.companyId === companyId &&
      context?.[kind === 'card' ? 'cardCompanies' : 'companyLinks'].some(
        (o) => o.id === id && o.logId === row.id && o.companyId === companyId,
      )
      ? context
      : null;
  }
  return null;
}

function companyContext(ctx: Ctx, id: Id, creationOnly = false): OutputContext | null {
  const row = ctx.db.get<{ id: Id; after: string | null; raw: string | null }>(
    "SELECT a.id,a.after,d.raw FROM action_log a LEFT JOIN decision d ON d.id=a.decision_id WHERE a.subject_kind='company' AND a.subject_id=? AND a.action IN ('company.create','company.update') AND (?=0 OR a.action='company.create') ORDER BY a.id DESC LIMIT 1",
    id,
    Number(creationOnly),
  );
  const context = row?.raw ? storedContext(row.raw) : null;
  const current = ctx.db.get<{ name: string }>('SELECT name FROM company WHERE id=?', id);
  return row &&
    (creationOnly || row.after === null || JSON.parse(row.after).name === current?.name) &&
    context?.companies.some((o) => o.id === id && o.logId === row.id)
    ? context
    : null;
}
function humanCompanyName(ctx: Ctx, id: Id): boolean {
  const row = ctx.db.get<{ actor_kind: string }>(
    "SELECT actor_kind FROM action_log WHERE subject_kind='company' AND subject_id=? AND action IN ('company.create','company.update') ORDER BY id DESC LIMIT 1",
    id,
  );
  // Owner log identity survives payload redaction. Purge cleanup records itself
  // as system, so it cannot accidentally adopt an earlier unsafe agent name.
  return row?.actor_kind === 'teammate' || row?.actor_kind === 'credential';
}
function referenceContext(ctx: Ctx, id: Id): OutputContext | null {
  const row = ctx.db.get<{ id: Id; raw: string | null }>(
    "SELECT a.id,d.raw FROM action_log a LEFT JOIN decision d ON d.id=a.decision_id WHERE a.subject_kind='reference' AND a.subject_id=? AND a.action='reference.record' ORDER BY a.id DESC LIMIT 1",
    id,
  );
  const context = row?.raw ? storedContext(row.raw) : null;
  return context?.references.some((o) => o.id === id && o.logId === row?.id) ? context : null;
}

function directHumanCompanyLink(ctx: Ctx, contactId: Id, companyId: Id): boolean {
  if (!ctx.db.get("SELECT id FROM company WHERE id=? AND created_by_kind IN ('teammate','credential')", companyId))
    return false;
  for (const row of ctx.db.all<{ after: string | null; decision_id: Id | null }>(
    "SELECT after,decision_id FROM action_log WHERE subject_kind='contact' AND subject_id=? AND action='contact.set_company' ORDER BY id DESC",
    contactId,
  )) {
    if (row.after === null) return false;
    if (JSON.parse(row.after).companyId === companyId) return row.decision_id === null;
  }
  return false;
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
    const current = ctx.db.get<{ text_set_by: string; needs_text: number; company_set_by: string | null }>(
      'SELECT text_set_by,needs_text,company_set_by FROM card WHERE id=?',
      card.id,
    );
    if (!current) unknown = true;
    if (current?.text_set_by === 'agent' && (!current.needs_text || card.title !== '(title removed)' || card.summary))
      inherit(currentContext(ctx, 'card', card.id));
    if (card.companyId !== null && current?.company_set_by === 'agent')
      inherit(relationshipContext(ctx, 'card', card.id, card.companyId));
  }
  for (const participant of input.participants) {
    const current = ctx.db.get<{ role_set_by: string }>(
      'SELECT role_set_by FROM contact WHERE id=?',
      participant.contactId,
    );
    if (!current) unknown = true;
    if (current?.role_set_by === 'agent' && (participant.roleCategory !== 'unknown' || participant.dealsAbout))
      inherit(currentContext(ctx, 'contact', participant.contactId));
    // companyIds are supplied even beyond the capped companies list.
    for (const companyId of participant.companyIds) {
      const link = ctx.db.get<{ set_by: string }>(
        'SELECT set_by FROM contact_company WHERE contact_id=? AND company_id=? AND removed=0',
        participant.contactId,
        companyId,
      );
      if (!link) unknown = true;
      else if (link.set_by === 'agent') inherit(relationshipContext(ctx, 'contact', participant.contactId, companyId));
    }
  }
  for (const company of input.companies) {
    const current = ctx.db.get<{ created_by_kind: string }>(
      'SELECT created_by_kind FROM company WHERE id=?',
      company.id,
    );
    // A current name needs its own actual company.create owner pointer. Legacy
    // creation without one cannot be certified by later links or citations.
    // Aliases are human-only Graph writes; they do not certify a generated name.
    // This covers participant, card and named-chat suppliers uniformly.
    // Human/credential company producers are the protected non-agent values.
    if (
      current?.created_by_kind !== 'teammate' &&
      current?.created_by_kind !== 'credential' &&
      !humanCompanyName(ctx, company.id)
    )
      inherit(companyContext(ctx, company.id));
    // References are not supplied as payloads, but contribute support IDs to
    // the spine scope. Their owner pointer carries the full producing context.
    // A legacy generated reference can itself be transitive; its citation alone
    // is insufficient. Human references remain protected current Graph values.
    for (const reference of ctx.db.all<{ id: Id; actor_kind: string | null }>(
      `SELECT r.id,(SELECT actor_kind FROM action_log WHERE subject_kind='reference'
         AND subject_id=r.id AND action='reference.record' ORDER BY id DESC LIMIT 1) AS actor_kind
       FROM company_reference r WHERE removed=0 AND (from_company_id=? OR to_company_id=?)`,
      company.id,
      company.id,
    ))
      if (reference.actor_kind !== 'teammate' && reference.actor_kind !== 'credential')
        inherit(referenceContext(ctx, reference.id));
  }
  return {
    version: 2,
    messageIds: [...messages].sort((a, b) => a - b),
    chatIds: [...chats].sort((a, b) => a - b),
    unknown,
    cards: [],
    roles: [],
    companies: [],
    companyLinks: [],
    cardCompanies: [],
    references: [],
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
    if (row.action === 'company.create') context.companies.push({ id: row.subject_id, logId: row.id });
    if (row.action === 'contact.set_company' && typeof after.companyId === 'number')
      context.companyLinks.push({ id: row.subject_id, logId: row.id, companyId: after.companyId });
    if (['card.create', 'card.update'].includes(row.action) && typeof after.companyId === 'number')
      context.cardCompanies.push({ id: row.subject_id, logId: row.id, companyId: after.companyId });
    if (row.action === 'reference.record') context.references.push({ id: row.subject_id, logId: row.id });
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
export function discoverGeneratedOutputs(ctx: Ctx, messageIds: Id[]) {
  if (!messageIds.length)
    return {
      cardIds: [],
      contactIds: [],
      companyIds: [],
      companyHistoryIds: [],
      companyLinks: [],
      cardCompanyIds: [],
      referenceIds: [],
    };
  const chats = new Set(
    ctx.db
      .all<{ chat_id: Id }>(
        'SELECT DISTINCT chat_id FROM message WHERE id IN (SELECT value FROM json_each(?))',
        JSON.stringify(messageIds),
      )
      .map((r) => r.chat_id),
  );
  function unsafe(kind: 'card' | 'contact', id: Id): boolean {
    return affected(currentContext(ctx, kind, id));
  }
  function affected(context: OutputContext | null): boolean {
    return (
      !context ||
      context.unknown ||
      context.messageIds.some((id) => messageIds.includes(id)) ||
      context.chatIds.some((id) => chats.has(id))
    );
  }
  return {
    companyHistoryIds: ctx.db
      .all<{ id: Id }>("SELECT id FROM company WHERE created_by_kind='agent'")
      .filter((r) => affected(companyContext(ctx, r.id, true)))
      .map((r) => r.id),
    companyIds: ctx.db
      .all<{ id: Id }>("SELECT id FROM company WHERE created_by_kind='agent'")
      .filter((r) => !humanCompanyName(ctx, r.id) && affected(companyContext(ctx, r.id)))
      .map((r) => r.id),
    companyLinks: ctx.db
      .all<{ contactId: Id; companyId: Id }>(
        "SELECT contact_id AS contactId,company_id AS companyId FROM contact_company WHERE set_by='agent'",
      )
      .filter(
        (r) =>
          affected(relationshipContext(ctx, 'contact', r.contactId, r.companyId)) &&
          !directHumanCompanyLink(ctx, r.contactId, r.companyId),
      ),
    cardCompanyIds: ctx.db
      .all<{ id: Id; company_id: Id }>(
        "SELECT id,company_id FROM card WHERE company_set_by='agent' AND company_id IS NOT NULL",
      )
      .filter((r) => affected(relationshipContext(ctx, 'card', r.id, r.company_id)))
      .map((r) => r.id),
    referenceIds: ctx.db
      .all<{ id: Id }>(
        "SELECT r.id FROM company_reference r WHERE NOT EXISTS (SELECT 1 FROM action_log a WHERE a.subject_kind='reference' AND a.subject_id=r.id AND a.actor_kind IN ('teammate','credential'))",
      )
      .filter((r) => affected(referenceContext(ctx, r.id)))
      .map((r) => r.id),
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
