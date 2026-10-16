import { readFileSync } from 'node:fs';
import type {
  Db,
  MovementConfig,
  MovementDecisionProvider,
  MovementHttpPort,
  MovementReplayLine,
  MovementResult,
  OpLog,
} from '../../contracts/index.ts';
import { AppError, MovementReplayLineSchema } from '../../contracts/index.ts';
import { jevProvider } from './jev.ts';
import { boundRequest, parseWire } from './wire.ts';

export async function createMovementProvider(
  cfg: MovementConfig,
  deps: {
    db: Db;
    oplog: OpLog;
    now(): Date;
    sleep(ms: number): Promise<void>;
    http: MovementHttpPort;
    replayLines?: MovementReplayLine[];
  },
): Promise<MovementDecisionProvider> {
  if (cfg.provider === 'jev') {
    if (deps.replayLines !== undefined || cfg.replayPath !== null)
      throw new AppError('invalid', 'Hosted movement cannot use replay');
    return jevProvider(cfg, deps);
  }
  if (cfg.provider === null) {
    if (deps.replayLines !== undefined || cfg.replayPath !== null)
      throw new AppError('invalid', 'Disabled movement cannot use replay');
    return {
      status: () => ({
        provider: null,
        execution: 'disabled',
        state: 'blocked',
        reason: 'missing_config',
        endpointHost: null,
        model: null,
      }),
      async decide(request, signal) {
        signal.throwIfAborted();
        if (request.options.length === 0)
          return {
            provider: 'jev',
            execution: 'disabled',
            configuredModel: null,
            providerRequestId: null,
            schemaVersion: 1,
            requestId: request.requestId,
            snapshotHash: request.snapshotHash,
            kind: 'not_requested',
            code: 'no_destination',
          };
        return {
          provider: 'jev',
          execution: 'disabled',
          configuredModel: null,
          providerRequestId: null,
          schemaVersion: 1,
          requestId: request.requestId,
          snapshotHash: request.snapshotHash,
          kind: 'failed',
          code: 'missing_config',
        };
      },
    };
  }
  if (
    (deps.replayLines !== undefined && cfg.replayPath !== null) ||
    (deps.replayLines === undefined && cfg.replayPath === null)
  )
    throw new AppError('invalid', 'Choose exactly one movement replay source');
  const raw =
    deps.replayLines ??
    readFileSync(cfg.replayPath as string, 'utf8')
      .split('\n')
      .filter((s) => s.trim())
      .map((s) => JSON.parse(s) as unknown);
  const lines = raw.map((value) => {
    const p = MovementReplayLineSchema.safeParse(value);
    if (!p.success) throw new AppError('invalid', 'Invalid movement replay');
    return p.data;
  });
  return {
    status: () => ({
      provider: 'jev',
      execution: 'replay',
      state: 'ready',
      reason: null,
      endpointHost: null,
      model: null,
    }),
    async decide(request, signal): Promise<MovementResult> {
      signal.throwIfAborted();
      const base = {
        provider: 'jev' as const,
        execution: 'replay' as const,
        configuredModel: null,
        providerRequestId: null,
        schemaVersion: 1 as const,
        requestId: request.requestId,
        snapshotHash: request.snapshotHash,
      };
      if (request.options.length === 0) return { ...base, kind: 'not_requested', code: 'no_destination' };
      let subjectKey: string;
      if (request.subject.kind === 'new_card') subjectKey = `new:${request.subject.openedByMessageKey}`;
      else if (request.subject.kind === 'proposal') subjectKey = `proposal:${request.subject.openedByMessageKey}`;
      else {
        const key = deps.db.get<{ message_key: string }>(
          'SELECT m.message_key FROM card c JOIN message m ON m.id=c.created_from_message_id WHERE c.id=?',
          request.subject.cardId,
        )?.message_key;
        if (!key) throw new AppError('invalid', 'Unknown replay card label');
        subjectKey = `card:${key}`;
      }
      const line = lines.find(
        (l) =>
          l.messageKey === request.message.key && l.version === request.message.version && l.subjectKey === subjectKey,
      );
      if (line && 'raw' in line) {
        try {
          return parseWire(line.raw, boundRequest(request), 'replay', null, null);
        } catch {
          return { ...base, kind: 'failed', code: 'invalid_response' };
        }
      }
      if (line && 'failure' in line) return { ...base, kind: 'failed', code: line.failure };
      const answer = line?.answer ?? {
        destination: 'stay' as const,
        evidenceMessageKeys: [request.message.key],
        confidence: 1,
        supportConfidence: 1,
      };
      const destination = answer.destination;
      const choice =
        typeof destination === 'string'
          ? destination
          : request.options.find(
              (o) =>
                request.lanes.find((l) => l.id === o.toLaneId)?.name === destination.lane &&
                request.lanes.flatMap((l) => l.stages).find((s) => s.id === o.toStageId)?.name === destination.stage,
            )?.id;
      if (!choice) throw new AppError('invalid', 'Unknown movement replay destination');
      const ids = answer.evidenceMessageKeys.map((key) => request.evidence.find((e) => e.key === key)?.id);
      const bundle = request.evidenceOptions.find(
        (o) => o.messageIds.length === ids.length && o.messageIds.every((id) => ids.includes(id)),
      );
      if (choice !== 'review' && !bundle) throw new AppError('invalid', 'Unknown movement replay evidence');
      const probabilities = Object.fromEntries(
        [...request.options.map((o) => o.id), 'stay', 'review'].map((id) => [id, Number(id === choice)]),
      );
      return {
        ...base,
        kind: 'answered',
        resolvedModel: null,
        movement: { choice, confidence: answer.confidence, probabilities },
        support:
          choice === 'review'
            ? null
            : {
                choice: (bundle as { id: string }).id,
                confidence: answer.supportConfidence,
                probabilities: Object.fromEntries(
                  [...request.evidenceOptions.map((o) => o.id), 'review'].map((id) => [id, Number(id === bundle?.id)]),
                ),
              },
        supportTarget: choice === 'review' ? null : choice,
        supportQuestionId: choice === 'review' ? null : `support:${choice}`,
        usage: null,
      };
    },
  };
}
