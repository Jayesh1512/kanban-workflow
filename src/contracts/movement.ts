import type { Id, IsoTime } from './index.ts';

export type MovementSubject =
  | { kind: 'card'; cardId: Id }
  | { kind: 'new_card'; openedByMessageKey: string }
  | { kind: 'proposal'; proposalId: Id; openedByMessageKey: string };

export interface MovementEvidence {
  id: Id;
  key: string;
  version: number;
  sentAt: IsoTime;
  text: string;
  media: string | null;
  replyToId: Id | null;
}

export interface MovementLane {
  id: Id;
  version: number;
  name: string;
  sop: string;
  stages: { id: Id; name: string; position: number; criteria: string }[];
}

export interface MovementOption {
  id: string;
  toLaneId: Id;
  toStageId: Id;
  laneVersion: number;
  criterionId: string;
  criterionLabel: string;
}

export interface MovementEvidenceOption {
  id: string;
  messageIds: Id[];
}

export interface MovementRequest {
  schemaVersion: 1;
  requestId: string;
  snapshotHash: string;
  message: { id: Id; key: string; version: number; chatId: Id };
  subject: MovementSubject;
  current: {
    laneId: Id;
    stageId: Id;
    laneVersion: number;
    title: string;
    summary: string;
    stageHumanSetAt: IsoTime | null;
  };
  lanes: MovementLane[];
  options: MovementOption[];
  evidence: MovementEvidence[];
  evidenceOptions: MovementEvidenceOption[];
}

export interface MovementChoice {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export type MovementFailure =
  | 'missing_config'
  | 'endpoint_blocked'
  | 'unauthorised'
  | 'unavailable'
  | 'timeout'
  | 'cancelled'
  | 'invalid_response'
  | 'stale'
  | 'context_limit';

export interface MovementResultBase {
  provider: 'jev';
  execution: 'hosted' | 'replay' | 'disabled';
  configuredModel: string | null;
  providerRequestId: string | null;
}

export type MovementResult = MovementResultBase &
  (
    | {
        schemaVersion: 1;
        requestId: string;
        snapshotHash: string;
        kind: 'answered';
        resolvedModel: string | null;
        movement: MovementChoice;
        support: MovementChoice | null;
        supportTarget: string | null;
        supportQuestionId: string | null;
        usage: { inputTokens: number; outputTokens: number } | null;
      }
    | { schemaVersion: 1; requestId: string; snapshotHash: string; kind: 'failed'; code: MovementFailure }
    | { schemaVersion: 1; requestId: string; snapshotHash: string; kind: 'not_requested'; code: 'no_destination' }
  );

export interface MovementProviderStatus {
  provider: 'jev' | null;
  execution: 'hosted' | 'replay' | 'disabled';
  state: 'ready' | 'blocked' | 'degraded';
  reason: MovementFailure | null;
  endpointHost: string | null;
  model: string | null;
}

export interface MovementDecisionProvider {
  decide(request: MovementRequest, signal: AbortSignal): Promise<MovementResult>;
  status(): MovementProviderStatus;
}

export interface MovementConfig {
  provider: 'jev' | 'replay' | null;
  endpoint: string | null;
  model: string | null;
  apiKey: string | null;
  replayPath: string | null;
  timeoutMs: number;
  maxAttempts: 1 | 2;
}

export interface MovementHttpPort {
  post(i: {
    url: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
    timeoutMs: number;
    redirect: 'error';
    maxResponseBytes: number;
  }): Promise<{ status: number; body: string; providerRequestId?: string }>;
}

export type MovementReplayLine =
  | {
      messageKey: string;
      version: number;
      subjectKey: string;
      answer: {
        destination: 'stay' | 'review' | { lane: string; stage: string };
        evidenceMessageKeys: string[];
        confidence: number;
        supportConfidence: number;
      };
    }
  | { messageKey: string; version: number; subjectKey: string; raw: unknown }
  | { messageKey: string; version: number; subjectKey: string; failure: MovementFailure };
