import { createHash } from 'node:crypto';
import type {
  AgentCancellationRegistration,
  Ctx,
  Db,
  Id,
  Model,
  ModelConfig,
  MovementDecisionProvider,
  MovementRequest,
  MovementResult,
  OpLog,
  Pipeline,
  PipelineStatus,
} from '../contracts/index.ts';
import { AppError, ModelDecisionSchema, ModelResponseError, ModelUnavailable } from '../contracts/index.ts';
import { bindOutputContext, captureOutputContext } from './forget.ts';
import { judge, readGuardFacts } from './guard.ts';
import { movementRequest } from './movement/subject.ts';
import { commitDecision, commitFailure } from './process.ts';
import { captureReviewSources } from './review-state.ts';
import { eligibleChat, eligibleMessage } from './selection.ts';
import { spineInput } from './spine-input.ts';
import { inputProvenance } from './spine-provenance.ts';

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
  let loop: Promise<Settlement<void>> | null = null;
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
  let since: string | null = null;
  let modelFailure: PipelineStatus['modelFailure'] = null;
  const delays = new Map<string, { due: number; failures: number }>();
  function retireDelays(): void {
    for (const key of delays.keys()) {
      const [chatId, id, version, birth] = key.split(':');
      const row = db.get<{ message_key: string; stored_at: string }>(
        'SELECT message_key,stored_at FROM message WHERE chat_id=? AND id=? AND version=? AND processed_version<version AND deleted_at IS NULL',
        Number(chatId),
        Number(id),
        Number(version),
      );
      if (!row || digest([row.message_key, row.stored_at]) !== birth) delays.delete(key);
    }
  }

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
  const chatEligible = (id: Id) => eligibleChat(ctx, id);
  const selectedEligible = (id: Id, version: number) => eligibleMessage(ctx, id, version);
  function digest(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
      generation++;
      running = true;
      stopped = false;
      since = now().toISOString();
      const loopGeneration = generation;
      const work = (async () => {
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
      })();
      loop = work.then(
        () => ({ kind: 'value', value: undefined }),
        (error: unknown) => {
          // Retain genuine failure for stop; an older loop cannot change a successor or log.
          if (generation === loopGeneration) {
            running = false;
            deps.oplog('error', 'pipeline.stopped', { code: 'spine_failed' });
          }
          return { kind: 'error', error };
        },
      );
    },
    async stop() {
      generation++;
      const stopGeneration = generation;
      stopped = true;
      running = false;
      const captured = attempt;
      captured?.cancel();
      idleCancel?.();
      for (const registration of captured?.registrations ?? []) registration.cancel();
      const work = active;
      const capturedLoop = loop;
      const loopOutcome = await capturedLoop;
      const outcome = work === null ? null : await work;
      if (generation === stopGeneration) {
        if (loop === capturedLoop) loop = null;
        since = null;
      }
      if (loopOutcome?.kind === 'error') throw loopOutcome.error;
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
        const next = db.get<{ id: Id; version: number; chat_id: Id; message_key: string; stored_at: string }>(
          `SELECT m.id,m.version,m.chat_id,m.message_key,m.stored_at FROM message m JOIN chat ch ON ch.id=m.chat_id WHERE m.processed_version<m.version AND m.deleted_at IS NULL AND ch.withdrawn_at IS NULL
           AND EXISTS (SELECT 1 FROM account_chat ac JOIN channel_account ca ON ca.id=ac.account_id JOIN teammate t ON t.id=ca.teammate_id
             JOIN chat_selection cs ON cs.account_id=ca.id AND cs.chat_key=ch.chat_key WHERE ac.chat_id=ch.id AND ca.channel=ch.channel
             AND ca.state NOT IN ('login','removed','auth_lost') AND t.removed_at IS NULL AND cs.decision='included')
           AND NOT EXISTS (SELECT 1 FROM account_chat ac WHERE ac.chat_id=m.chat_id AND ac.sync_state<>'idle')
           AND NOT EXISTS (SELECT 1 FROM message older WHERE older.chat_id=m.chat_id AND older.processed_version<older.version AND older.deleted_at IS NULL AND (older.sent_at<m.sent_at OR (older.sent_at=m.sent_at AND older.id<m.id))) ORDER BY CASE m.origin WHEN 'live' THEN 0 ELSE 1 END,m.sent_at,m.id LIMIT 1`,
        );
        if (!next) return null;
        const delayKey = `${next.chat_id}:${next.id}:${next.version}:${digest([next.message_key, next.stored_at])}`;
        const delay = delays.get(delayKey);
        if (delay && now().getTime() < delay.due) return null;
        const selected = next;
        const input = spineInput(ctx, next.id);
        const inputHash = digest(input);
        const dependencies = inputProvenance(ctx, input, chatEligible);
        if (!dependencies || !selectedEligible(next.id, next.version)) return null;
        // Freeze the producing support at the same time as the actual supplied
        // input, before either provider can yield and owner history can change.
        const outputContext = captureOutputContext(ctx, input, dependencies.scope);
        const fullScope = { chatIds: outputContext.chatIds, messageIds: outputContext.messageIds };
        const reviewSources = captureReviewSources(ctx, fullScope);
        if (!reviewSources) return null;
        const sourceHash = digest(reviewSources);
        const captured = newAttempt();
        attempt = captured;
        function fresh(): boolean {
          if (!live(captured)) return false;
          // Always read actual Db before any provider/status/apply continuation.
          if (!selectedEligible(selected.id, selected.version)) return false;
          if (digest(input) !== inputHash || digest(spineInput(ctx, selected.id)) !== inputHash) return false;
          return (
            inputProvenance(ctx, input, chatEligible)?.hash === dependencies?.hash &&
            digest(captureReviewSources(ctx, fullScope)) === sourceHash
          );
        }
        try {
          captured.registrations.push(db.registerAgentCancellation(fullScope, captured.controller));
          // Successful native registration proves the synchronous idle SQL boundary.
          retireDelays();
          if (!fresh()) return null;
          let callsUsed = 0;
          let raw: unknown;
          let terminal: PipelineStatus['modelFailure'] = null;
          for (;;) {
            if (!fresh() || model.blocked) return null;
            callsUsed++;
            const general = await observe(captured, () => model.decide(input, captured.controller.signal));
            if (!fresh() || general.kind === 'cancelled') return null;
            let error: unknown;
            if (general.kind === 'value') {
              const parsed = ModelDecisionSchema.safeParse(general.value);
              if (parsed.success) {
                raw = parsed.data;
                terminal = null;
                break;
              }
              error = new ModelResponseError('schema_invalid');
            } else error = general.error;
            if (captured.controller.signal.aborted) return null;
            if (error instanceof ModelUnavailable) {
              modelFailure = error.code;
              if (callsUsed < modelMaxAttempts && !model.blocked) {
                const wait = await observe(captured, () => deps.sleep(1000));
                if (!fresh() || wait.kind === 'cancelled') return null;
                if (wait.kind === 'error') throw wait.error;
                continue;
              }
              const failures = (delay?.failures ?? 0) + 1;
              delays.set(delayKey, {
                failures,
                due: now().getTime() + Math.min(300000, 30000 * 2 ** Math.min(failures - 1, 4)),
              });
              return null;
            }
            if (!(error instanceof ModelResponseError)) throw error;
            terminal = error.code;
            if (
              (terminal === 'incomplete' || terminal === 'schema_invalid') &&
              callsUsed < modelMaxAttempts &&
              !model.blocked
            )
              continue;
            modelFailure = terminal;
            break;
          }
          if (terminal) {
            if (!fresh()) return null;
            return db.tx(() => {
              if (!fresh()) return null;
              const id = commitFailure(ctx, input, terminal, model.name);
              const decisionId = db.get<{ id: Id }>(
                'SELECT id FROM decision WHERE message_id=? AND message_version=?',
                next.id,
                next.version,
              )?.id;
              if (decisionId) bindOutputContext(ctx, decisionId, outputContext);
              delays.delete(delayKey);
              return id;
            });
          }
          const d = ModelDecisionSchema.parse(raw);
          const preview = judge(d, readGuardFacts(db, input.message.id, d));
          const subjectAllowed =
            preview.some(
              (o) =>
                (o.do === 'apply' && ['card.create', 'message.attach'].includes(o.action.type)) ||
                (o.do === 'review' && ['new_card', 'attach'].includes(o.kind)),
            ) ||
            (d.disposition === 'join' &&
              input.proposals.some((p) => p.id === d.proposalId) &&
              !preview.some(
                (o) =>
                  o.do === 'refuse' &&
                  [
                    'unknown_identifier',
                    'unoffered_company',
                    'invalid_evidence',
                    'unknown_proposal',
                    'invalid_decision',
                  ].includes(o.why),
              ));
          const request: MovementRequest | null = subjectAllowed ? movementRequest(ctx, input, d) : null;
          let result: MovementResult | null = null;
          if (request) {
            if (!fresh()) return null;
            captured.registrations.push(
              db.registerAgentCancellation(
                {
                  chatIds: fullScope.chatIds,
                  messageIds: [...new Set([...fullScope.messageIds, ...request.evidence.map((e) => e.id)])],
                },
                captured.controller,
              ),
            );
            const requestHash = digest(request);
            const reply = await observe(captured, () => movement.decide(request, captured.controller.signal));
            if (!fresh() || reply.kind === 'cancelled' || digest(request) !== requestHash) return null;
            if (reply.kind === 'error') throw reply.error;
            result =
              reply.kind === 'value'
                ? reply.value
                : {
                    provider: 'jev',
                    execution: 'disabled',
                    configuredModel: null,
                    providerRequestId: null,
                    schemaVersion: 1,
                    requestId: request.requestId,
                    snapshotHash: request.snapshotHash,
                    kind: 'failed',
                    code: 'invalid_response',
                  };
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
            commitDecision(ctx, input, raw, d, model.name, request, result, reviewSources);
            const decisionId = db.get<{ id: Id }>(
              'SELECT id FROM decision WHERE message_id=? AND message_version=?',
              next.id,
              next.version,
            )?.id;
            if (decisionId) bindOutputContext(ctx, decisionId, outputContext);
            modelFailure = null;
            delays.delete(delayKey);
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
        state: model.blocked ? 'blocked' : delays.size && count ? 'paused' : running ? 'running' : 'stopped',
        reason: model.blocked ?? (delays.size && count ? 'model_unavailable' : null),
        since,
        pending: count,
        movement: movement.status(),
        modelFailure,
      };
    },
  };
  return pipeline;
}
