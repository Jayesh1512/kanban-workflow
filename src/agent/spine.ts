import { createHash } from 'node:crypto';
import { attachMessage, createCard, moveCard } from '../board/index.ts';
import type {
  AgentCancellationRegistration,
  AgentWorkScope,
  Ctx,
  Db,
  DecideInput,
  Id,
  Model,
  ModelConfig,
  MovementDecisionProvider,
  MovementRequest,
  OpLog,
  Pipeline,
} from '../contracts/index.ts';
import { AppError, ModelDecisionSchema, MovementResultSchema, ReviewProposalSchema } from '../contracts/index.ts';
import { record } from '../log/index.ts';
import { spineActions } from './spine-actions.ts';
import { spineInput } from './spine-input.ts';

export function createPipeline(deps: {
  db: Db;
  model: Model;
  modelMaxAttempts: ModelConfig['maxAttempts'];
  movement: MovementDecisionProvider;
  now(): Date;
  sleep(ms: number): Promise<void>;
  oplog: OpLog;
}): Pipeline {
  const modelMaxAttempts = deps.modelMaxAttempts;
  if (modelMaxAttempts !== 1 && modelMaxAttempts !== 2)
    throw new AppError('invalid', 'Invalid pipeline modelMaxAttempts');
  const { db, now, model, movement } = deps;
  const ctx: Ctx = { db, now, actor: { kind: 'agent' }, canReadText: true };
  let running = false;
  let stopped = false;
  let loop: Promise<void> | null = null;
  type Settlement<T> = { kind: 'value'; value: T } | { kind: 'error'; error: unknown } | { kind: 'cancelled' };
  type Attempt = {
    readonly token: object;
    readonly generation: number;
    readonly controller: AbortController;
    readonly registrations: AgentCancellationRegistration[];
    readonly cancelled: Promise<Settlement<never>>;
    cancel(): void;
    detach(): void;
    retired: boolean;
  };
  let generation = 0;
  let active: Promise<Settlement<Id | null>> | null = null;
  let attempt: Attempt | null = null;
  let idleCancel: (() => void) | null = null;
  let loopFailure: { error: unknown } | null = null;
  let since: string | null = null;

  function live(a: Attempt): boolean {
    return (
      !stopped &&
      generation === a.generation &&
      attempt?.token === a.token &&
      !a.retired &&
      !a.controller.signal.aborted
    );
  }
  function newAttempt(): Attempt {
    const controller = new AbortController();
    const cancellation = Promise.withResolvers<Settlement<never>>();
    const cancel = () => cancellation.resolve({ kind: 'cancelled' });
    controller.signal.addEventListener('abort', cancel, { once: true });
    return {
      token: {},
      generation,
      controller,
      registrations: [],
      cancelled: cancellation.promise,
      cancel,
      detach: () => controller.signal.removeEventListener('abort', cancel),
      retired: false,
    };
  }
  function handled<T>(raw: Promise<T>, valid: () => boolean): Promise<Settlement<T>> {
    // Both handlers are attached immediately. Losing raw outcomes perform no Db/log/status work.
    return raw.then(
      (value) => (valid() ? { kind: 'value', value } : { kind: 'cancelled' }),
      (error: unknown) => (valid() ? { kind: 'error', error } : { kind: 'cancelled' }),
    );
  }
  function observe<T>(a: Attempt, run: () => Promise<T>): Promise<Settlement<T>> {
    try {
      return Promise.race([handled(run(), () => live(a)), a.cancelled]);
    } catch (error) {
      return Promise.resolve(live(a) ? { kind: 'error', error } : { kind: 'cancelled' });
    }
  }
  function chatEligible(chatId: Id): boolean {
    return (
      ctx.canReadText &&
      Boolean(
        db.get(
          `SELECT ch.id FROM chat ch WHERE ch.id=? AND ch.withdrawn_at IS NULL
       AND EXISTS (SELECT 1 FROM account_chat ac JOIN channel_account ca ON ca.id=ac.account_id
         JOIN teammate t ON t.id=ca.teammate_id JOIN chat_selection cs ON cs.account_id=ca.id AND cs.chat_key=ch.chat_key
         WHERE ac.chat_id=ch.id AND ca.channel=ch.channel AND ca.state NOT IN ('login','removed','auth_lost')
         AND t.removed_at IS NULL AND cs.decision='included')
       AND NOT EXISTS (SELECT 1 FROM account_chat ac WHERE ac.chat_id=ch.id AND ac.sync_state<>'idle')`,
          chatId,
        ),
      )
    );
  }
  function selectedEligible(id: Id, version: number): boolean {
    const row = db.get<{ chat_id: Id }>(
      'SELECT chat_id FROM message WHERE id=? AND version=? AND processed_version<version AND deleted_at IS NULL',
      id,
      version,
    );
    return Boolean(row && chatEligible(row.chat_id));
  }
  function digest(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
  function provenance(input: DecideInput) {
    const messages = new Set([input.message.id, ...input.recent.map((m) => m.id)]);
    const chats = new Set([input.chat.id]);
    const cardIds = JSON.stringify(input.cards.map((c) => c.id));
    const proposalIds = JSON.stringify(input.proposals.map((p) => p.id));
    const contactIds = JSON.stringify(input.participants.map((p) => p.contactId));
    const companyIds = JSON.stringify(input.companies.map((c) => c.id));
    const participantCompanyIds = JSON.stringify([...new Set(input.participants.flatMap((p) => p.companyIds))]);
    const cards = db.all<{
      id: Id;
      created_from_message_id: Id | null;
      text_set_by: string;
      title: string;
      summary: string;
    }>('SELECT * FROM card WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id', cardIds);
    const cardMessages = db.all<{ card_id: Id; message_id: Id }>(
      'SELECT * FROM card_message WHERE card_id IN (SELECT value FROM json_each(?)) ORDER BY card_id,message_id',
      cardIds,
    );
    for (const c of cards) {
      if (c.created_from_message_id !== null) messages.add(c.created_from_message_id);
      if (
        c.text_set_by === 'agent' &&
        (c.title || c.summary) &&
        c.created_from_message_id === null &&
        !cardMessages.some((m) => m.card_id === c.id)
      )
        return null;
    }
    for (const m of cardMessages) messages.add(m.message_id);
    const cardChats = db.all<{ chat_id: Id }>(
      'SELECT * FROM card_chat WHERE card_id IN (SELECT value FROM json_each(?)) ORDER BY card_id,chat_id',
      cardIds,
    );
    for (const ch of cardChats) chats.add(ch.chat_id);
    const proposals = db.all(
      'SELECT * FROM review_item WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id',
      proposalIds,
    );
    const reviewMessages = db.all<{ review_item_id: Id; message_id: Id; decision_id: Id | null }>(
      'SELECT * FROM review_message WHERE review_item_id IN (SELECT value FROM json_each(?)) ORDER BY review_item_id,message_id',
      proposalIds,
    );
    for (const m of reviewMessages) messages.add(m.message_id);
    if (input.proposals.some((p) => !reviewMessages.some((m) => m.review_item_id === p.id))) return null;
    const decisions = db.all<{ message_id: Id }>(
      'SELECT * FROM decision WHERE id IN (SELECT decision_id FROM review_message WHERE review_item_id IN (SELECT value FROM json_each(?))) ORDER BY id',
      proposalIds,
    );
    for (const d of decisions) messages.add(d.message_id);
    const audits = db.all<{ snapshot: string; result: string }>(
      'SELECT * FROM movement_decision WHERE decision_id IN (SELECT decision_id FROM review_message WHERE review_item_id IN (SELECT value FROM json_each(?))) ORDER BY decision_id',
      proposalIds,
    );
    // Stored private audits contribute only their actual evidence/message identifiers, never lane/card IDs.
    function auditMessages(value: unknown, key = ''): void {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (
            ['messageIds', 'evidenceMessageIds', 'supportingMessageIds'].includes(key) &&
            typeof item === 'number' &&
            Number.isSafeInteger(item) &&
            item > 0
          )
            messages.add(item);
          else auditMessages(item, key);
        }
      } else if (value !== null && typeof value === 'object') {
        for (const [name, item] of Object.entries(value)) {
          if (
            (name === 'messageId' || (name === 'id' && key === 'evidence')) &&
            typeof item === 'number' &&
            Number.isSafeInteger(item) &&
            item > 0
          )
            messages.add(item);
          else auditMessages(item, name);
        }
      }
    }
    for (const audit of audits) {
      auditMessages(JSON.parse(audit.snapshot));
      auditMessages(JSON.parse(audit.result));
    }
    const participants = db.all<{
      first_seen_at: string;
      identity_id: Id;
      id: Id;
      role_set_by: string;
      role_category: string;
      deals_about: string;
    }>(
      'SELECT cp.*,i.*,c.* FROM chat_participant cp JOIN identity i ON i.id=cp.identity_id JOIN contact c ON c.id=i.contact_id WHERE cp.chat_id=? AND c.id IN (SELECT value FROM json_each(?)) ORDER BY i.id',
      input.chat.id,
      contactIds,
    );
    for (const p of participants) {
      const first = db.get<{ id: Id }>(
        'SELECT id FROM message WHERE chat_id=? AND sender_identity_id=? AND sent_at=? ORDER BY id LIMIT 1',
        input.chat.id,
        p.identity_id,
        p.first_seen_at,
      );
      if (first) messages.add(first.id);
    }
    const links = db.all<{ contact_id: Id; company_id: Id; set_by: string; removed: number }>(
      'SELECT * FROM contact_company WHERE contact_id IN (SELECT value FROM json_each(?)) ORDER BY contact_id,company_id',
      contactIds,
    );
    const evidence = db.all<{ contact_id: Id; company_id: Id | null; kind: string; message_id: Id }>(
      `SELECT * FROM evidence WHERE contact_id IN (SELECT value FROM json_each(?))
       AND (kind='contact_role' OR company_id IN (SELECT value FROM json_each(?))) ORDER BY id`,
      contactIds,
      participantCompanyIds,
    );
    if (
      participants.some(
        (p) =>
          p.role_set_by === 'agent' &&
          (p.role_category !== 'unknown' || p.deals_about) &&
          !evidence.some((e) => e.contact_id === p.id && e.kind === 'contact_role'),
      )
    )
      return null;
    if (
      links.some(
        (l) =>
          l.set_by === 'agent' &&
          l.removed === 0 &&
          !evidence.some(
            (e) => e.contact_id === l.contact_id && e.company_id === l.company_id && e.kind === 'contact_company',
          ),
      )
    )
      return null;
    for (const e of evidence) messages.add(e.message_id);
    const companies = db.all(
      'SELECT * FROM company WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id',
      companyIds,
    );
    const aliases = db.all(
      'SELECT * FROM company_alias WHERE company_id IN (SELECT value FROM json_each(?)) ORDER BY alias_norm',
      companyIds,
    );
    const references = db.all<{ message_id: Id }>(
      'SELECT * FROM company_reference WHERE removed=0 AND (from_company_id IN (SELECT value FROM json_each(?)) OR to_company_id IN (SELECT value FROM json_each(?))) ORDER BY id',
      companyIds,
      companyIds,
    );
    for (const r of references) messages.add(r.message_id);
    const sources = [];
    for (const id of [...messages].sort((a, b) => a - b)) {
      const m = db.get<{ chat_id: Id; deleted_at: string | null }>('SELECT * FROM message WHERE id=?', id);
      if (!m || m.deleted_at !== null) return null;
      chats.add(m.chat_id);
      sources.push(m);
    }
    const authority = [];
    for (const id of [...chats].sort((a, b) => a - b)) {
      if (!chatEligible(id)) return null;
      authority.push({
        chat: db.get('SELECT * FROM chat WHERE id=?', id),
        owners: db.all(
          `SELECT ac.account_id,ac.sync_state,ac.agreement_stale_since,ca.state,ca.teammate_id,t.removed_at,cs.decision
           FROM account_chat ac JOIN channel_account ca ON ca.id=ac.account_id JOIN teammate t ON t.id=ca.teammate_id
           JOIN chat ch ON ch.id=ac.chat_id JOIN chat_selection cs ON cs.account_id=ca.id AND cs.chat_key=ch.chat_key
           WHERE ac.chat_id=? ORDER BY ac.account_id`,
          id,
        ),
      });
    }
    const scope: AgentWorkScope = {
      chatIds: [...chats].sort((a, b) => a - b),
      messageIds: [...messages].sort((a, b) => a - b),
    };
    return {
      scope,
      hash: digest({
        cards,
        cardMessages,
        cardChats,
        proposals,
        reviewMessages,
        decisions,
        audits,
        participants,
        links,
        evidence,
        companies,
        aliases,
        references,
        sources,
        authority,
      }),
    };
  }
  function pending(): number {
    return (
      db.get<{ n: number }>('SELECT count(*) AS n FROM message WHERE processed_version<version AND deleted_at IS NULL')
        ?.n ?? 0
    );
  }
  const pipeline: Pipeline = {
    start() {
      if (running) return;
      running = true;
      stopped = false;
      loopFailure = null;
      since = now().toISOString();
      const loopGeneration = generation;
      loop = (async () => {
        while (running && generation === loopGeneration) {
          const id = await pipeline.processNext();
          if (!running || generation !== loopGeneration) return;
          pending(); // Actual Db fence even when a terminal fault could not deliver an abort.
          if (id === null) {
            const cancellation = Promise.withResolvers<Settlement<void>>();
            const cancel = () => cancellation.resolve({ kind: 'cancelled' });
            idleCancel = cancel;
            try {
              const result = await Promise.race([
                handled(deps.sleep(1000), () => running && generation === loopGeneration),
                cancellation.promise,
              ]);
              if (!running || generation !== loopGeneration) return;
              pending();
              if (result.kind === 'error') throw result.error;
            } finally {
              if (idleCancel === cancel) idleCancel = null;
            }
          }
        }
      })().catch((error: unknown) => {
        // A loop owns safe reporting, while stop retains genuine failure identity.
        loopFailure = { error };
        running = false;
        deps.oplog('error', 'pipeline.stopped', { code: 'spine_failed' });
      });
    },
    async stop() {
      generation++;
      stopped = true;
      running = false;
      const captured = attempt;
      captured?.cancel();
      idleCancel?.();
      for (const registration of captured?.registrations ?? []) registration.cancel();
      const work = active;
      await loop;
      const outcome = work === null ? null : await work;
      loop = null;
      since = null;
      if (loopFailure) throw loopFailure.error;
      if (outcome?.kind === 'error') throw outcome.error;
    },
    async processNext() {
      const callGeneration = generation;
      if (active) {
        const previous = await active;
        if (stopped || generation !== callGeneration) return null;
        pending();
        if (previous.kind === 'error') throw previous.error;
        return pipeline.processNext();
      }
      if (stopped || model.blocked) return null;
      const completed = Promise.withResolvers<Settlement<Id | null>>();
      const completion = completed.promise;
      active = completion;
      const work = (async () => {
        const next = db.get<{ id: Id; version: number }>(
          `SELECT m.id,m.version FROM message m JOIN chat ch ON ch.id=m.chat_id WHERE m.processed_version<m.version AND m.deleted_at IS NULL AND ch.withdrawn_at IS NULL
           AND EXISTS (SELECT 1 FROM account_chat ac JOIN channel_account ca ON ca.id=ac.account_id JOIN teammate t ON t.id=ca.teammate_id
             JOIN chat_selection cs ON cs.account_id=ca.id AND cs.chat_key=ch.chat_key WHERE ac.chat_id=ch.id AND ca.channel=ch.channel
             AND ca.state NOT IN ('login','removed','auth_lost') AND t.removed_at IS NULL AND cs.decision='included')
           AND NOT EXISTS (SELECT 1 FROM account_chat ac WHERE ac.chat_id=m.chat_id AND ac.sync_state<>'idle')
           AND NOT EXISTS (SELECT 1 FROM message older WHERE older.chat_id=m.chat_id AND older.processed_version<older.version AND older.deleted_at IS NULL AND (older.sent_at<m.sent_at OR (older.sent_at=m.sent_at AND older.id<m.id))) ORDER BY CASE m.origin WHEN 'live' THEN 0 ELSE 1 END,m.sent_at,m.id LIMIT 1`,
        );
        if (!next) return null;
        const selected = next;
        const input = spineInput(ctx, next.id);
        const inputHash = digest(input);
        const dependencies = provenance(input);
        if (!dependencies || !selectedEligible(next.id, next.version)) return null;
        const captured = newAttempt();
        attempt = captured;
        function fresh(): boolean {
          if (!live(captured)) return false;
          // Always read actual Db before any provider/status/apply continuation.
          if (!selectedEligible(selected.id, selected.version) || model.blocked) return false;
          if (digest(input) !== inputHash || digest(spineInput(ctx, selected.id)) !== inputHash) return false;
          return provenance(input)?.hash === dependencies?.hash;
        }
        try {
          captured.registrations.push(db.registerAgentCancellation(dependencies.scope, captured.controller));
          if (!fresh()) return null;
          const general = await observe(captured, () => model.decide(input, captured.controller.signal));
          if (!fresh() || general.kind === 'cancelled') return null;
          if (general.kind === 'error') throw general.error;
          const raw = general.value;
          const parsed = ModelDecisionSchema.safeParse(raw);
          if (!parsed.success) throw new AppError('invalid', 'Invalid spine model decision');
          const d = parsed.data;
          if (d.disposition === 'create' || d.disposition === 'attach' || d.disposition === 'join') {
            const subjectLane =
              d.laneId ??
              input.cards.find((c) => c.id === d.cardId)?.laneId ??
              input.proposals.find((p) => p.id === d.proposalId)?.laneId;
            const l = input.lanes.find((l) => l.id === subjectLane);
            if (!l) throw new AppError('invalid', 'Unknown subject lane');
            const stage = input.cards.find((c) => c.id === d.cardId)?.stageId ?? l.stages[0]?.id;
            if (stage === undefined) throw new AppError('invalid', 'Missing initial stage');
            const options = input.lanes
              .filter((other) => other.id !== l.id)
              .flatMap((other) =>
                other.stages.map((s) => ({
                  id: `lane:${other.id}:v:${other.version}:stage:${s.id}:criterion:${digest(s.criteria)}`,
                  toLaneId: other.id,
                  toStageId: s.id,
                  laneVersion: other.version,
                  criterionId: `stage:${s.id}:v:${other.version}:${digest(s.criteria)}`,
                  criterionLabel: s.position === 0 ? other.sop : s.criteria,
                })),
              );
            const request: MovementRequest = {
              schemaVersion: 1,
              requestId: `spine:${next.id}:${next.version}`,
              snapshotHash: digest({ messageId: next.id, version: next.version, lane: l.id, stage }),
              message: { id: next.id, key: input.message.key, version: next.version, chatId: input.chat.id },
              subject:
                d.disposition === 'create'
                  ? { kind: 'new_card', openedByMessageKey: input.message.key }
                  : d.disposition === 'join'
                    ? {
                        kind: 'proposal',
                        proposalId: d.proposalId as Id,
                        openedByMessageKey:
                          input.proposals.find((p) => p.id === d.proposalId)?.openedByMessageKey ?? input.message.key,
                      }
                    : { kind: 'card', cardId: d.cardId as Id },
              current: {
                laneId: l.id,
                stageId: stage,
                laneVersion: l.version,
                title:
                  d.title ??
                  input.cards.find((c) => c.id === d.cardId)?.title ??
                  input.proposals.find((p) => p.id === d.proposalId)?.title ??
                  '',
                summary: d.summary ?? '',
                stageHumanSetAt: null,
              },
              lanes: input.lanes,
              options,
              evidence: [
                {
                  id: next.id,
                  key: input.message.key,
                  version: next.version,
                  sentAt: input.message.sentAt,
                  text: input.message.text,
                  media: input.message.media,
                  replyToId: input.message.replyToId,
                },
              ],
              evidenceOptions: [{ id: `message:${next.id}:v:${next.version}`, messageIds: [next.id] }],
            };
            if (!fresh()) return null;
            // The actual thin request uses this input's subject/lanes and current-message evidence.
            captured.registrations.push(
              db.registerAgentCancellation(
                {
                  chatIds: dependencies.scope.chatIds,
                  messageIds: [...new Set([...dependencies.scope.messageIds, ...request.evidence.map((e) => e.id)])],
                },
                captured.controller,
              ),
            );
            if (!fresh()) return null;
            const requestHash = digest(request);
            const reply = await observe(captured, () => movement.decide(request, captured.controller.signal));
            if (!fresh() || reply.kind === 'cancelled' || digest(request) !== requestHash) return null;
            if (reply.kind === 'error') throw reply.error;
            const result = MovementResultSchema.parse(reply.value);
            if (result.requestId !== request.requestId || result.snapshotHash !== request.snapshotHash)
              throw new AppError('invalid', 'Movement replay correlation differs');
            if (result.kind === 'failed' || (result.kind === 'answered' && result.movement.choice !== 'stay'))
              throw new AppError('invalid', 'not built: processNext');
          }
          if (!fresh()) return null;
          return db.tx(() => {
            if (!fresh()) return null;
            const current = db.get<{
              version: number;
              processed_version: number;
              withdrawn_at: string | null;
              deleted_at: string | null;
            }>(
              'SELECT m.version,m.processed_version,m.deleted_at,ch.withdrawn_at FROM message m JOIN chat ch ON ch.id=m.chat_id WHERE m.id=?',
              next.id,
            );
            if (
              !current ||
              current.version !== next.version ||
              current.processed_version >= next.version ||
              current.deleted_at !== null ||
              current.withdrawn_at !== null
            )
              return null;
            const decisionId = db.run(
              "INSERT INTO decision(message_id,message_version,outcome,disposition,confidence,reason,lane_versions,model,raw,decided_at) VALUES (?,?,'none',?,?,?,?,?,?,?)",
              next.id,
              next.version,
              d.disposition,
              d.confidence,
              d.reason,
              JSON.stringify(Object.fromEntries(input.lanes.map((l) => [l.id, l.version]))),
              model.name,
              JSON.stringify(raw),
              now().toISOString(),
            ).lastInsertRowid;
            const outcome = spineActions(ctx, spineInput(ctx, next.id), d, decisionId);
            db.run('UPDATE decision SET outcome=? WHERE id=?', outcome, decisionId);
            db.run('UPDATE message SET processed_version=? WHERE id=?', next.version, next.id);
            return next.id;
          });
        } finally {
          captured.retired = true;
          captured.detach();
          for (const registration of captured.registrations) registration.release();
          if (attempt?.token === captured.token) attempt = null;
        }
      })();
      void handled(work, () => true).then(completed.resolve);
      try {
        const outcome = await completion;
        if (outcome.kind === 'error') throw outcome.error;
        return outcome.kind === 'value' ? outcome.value : null;
      } finally {
        if (active === completion) active = null;
      }
    },
    async drain() {
      let count = 0;
      const drainGeneration = generation;
      for (;;) {
        const id = await pipeline.processNext();
        if (stopped || generation !== drainGeneration) return count;
        pending();
        if (id === null) return count;
        count++;
      }
    },
    status() {
      const count = pending();
      return {
        state: model.blocked ? 'blocked' : running ? 'running' : 'stopped',
        reason: model.blocked,
        since,
        pending: count,
        movement: movement.status(),
        modelFailure: null,
      };
    },
  };
  return pipeline;
}
export function acceptReview(ctx: Ctx, id: Id): void {
  if (ctx.actor.kind !== 'teammate') throw new AppError('forbidden', 'Teammate required');
  ctx.db.tx(() => {
    const row = ctx.db.get<{ kind: string; proposal: string; status: string }>(
      'SELECT kind,proposal,status FROM review_item WHERE id=?',
      id,
    );
    if (!row) throw new AppError('not_found', 'Review not found');
    if (row.kind !== 'new_card') throw new AppError('invalid', 'not built: acceptReview');
    if (row.status !== 'open') throw new AppError('conflict', 'Review already settled');
    const proposal = ReviewProposalSchema.parse(JSON.parse(row.proposal));
    if (proposal.kind !== 'new_card') throw new AppError('invalid', 'Invalid new-card proposal');
    const messages = ctx.db.all<{
      id: Id;
      chat_id: Id;
      origin: string;
      deleted_at: string | null;
      withdrawn_at: string | null;
    }>(
      'SELECT m.id,m.chat_id,m.origin,m.deleted_at,ch.withdrawn_at FROM review_message rm JOIN message m ON m.id=rm.message_id JOIN chat ch ON ch.id=m.chat_id WHERE rm.review_item_id=? ORDER BY m.sent_at,m.id',
      id,
    );
    if (!messages.length || messages.some((m) => m.deleted_at !== null || m.withdrawn_at !== null))
      throw new AppError('conflict', 'Review evidence is unavailable');
    if (
      proposal.move !== null &&
      !ctx.db.get(
        'SELECT id FROM stage WHERE id=? AND lane_id=? AND removed_at IS NULL',
        proposal.move.toStageId,
        proposal.laneId,
      )
    )
      throw new AppError('invalid', 'Cross-lane movement is outside spine');
    const first = messages[0] as { id: Id; chat_id: Id; origin: string };
    const card = createCard(
      ctx,
      {
        laneId: proposal.laneId,
        title: proposal.title,
        summary: proposal.summary,
        companyId: proposal.companyId,
        chatId: first.chat_id,
        messageId: first.id,
        fromHistory: first.origin === 'history',
      },
      { setBy: 'human' },
    );
    for (const message of messages.slice(1)) attachMessage(ctx, message.id, card.id, { setBy: 'human' });
    if (proposal.move !== null)
      moveCard(
        ctx,
        card.id,
        {
          stageId: proposal.move.toStageId,
          criterion: proposal.move.criterion,
          evidenceMessageIds: messages.map((m) => m.id),
        },
        { setBy: 'human' },
      );
    ctx.db.run(
      "UPDATE review_item SET status='accepted',result_card_id=?,resolved_by=?,resolved_at=?,updated_at=? WHERE id=?",
      card.id,
      ctx.actor.kind === 'teammate' ? ctx.actor.id : null,
      ctx.now().toISOString(),
      ctx.now().toISOString(),
      id,
    );
    record(ctx, {
      action: 'review.accept',
      subjectKind: 'review',
      subjectId: id,
      after: { cardId: card.id },
      messageIds: messages.map((m) => m.id),
    });
  });
}
