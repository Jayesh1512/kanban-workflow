import type { Id, IsoTime } from './index.ts';

export interface Model {
  readonly name: string;
  readonly endpointHost: string | null;
  readonly blocked:
    | 'no_model'
    | 'model_config_missing'
    | 'model_endpoint_blocked'
    | 'model_unauthorised'
    | 'model_configuration_invalid'
    | null;

  decide(input: DecideInput, signal: AbortSignal): Promise<unknown>;
}

export class ModelUnavailable extends Error {
  readonly code: 'unavailable' | 'timeout';
  constructor(code: 'unavailable' | 'timeout' = 'unavailable') {
    super(code);
    this.name = 'ModelUnavailable';
    this.code = code;
  }
}

export interface DecideInput {
  message: {
    id: Id;
    key: string;
    version: number;
    sentAt: IsoTime;
    senderUserKey: string;
    senderIsTeammate: boolean;
    text: string;
    media: string | null;
    replyToId: Id | null;
    currentCardId: Id | null;
  };
  chat: { id: Id; kind: 'direct' | 'group' | 'broadcast'; title: string };
  recent: {
    id: Id;
    key: string;
    sentAt: IsoTime;
    senderUserKey: string;
    senderIsTeammate: boolean;
    text: string;
    cardId: Id | null;
  }[];

  lanes: {
    id: Id;
    name: string;
    version: number;
    sop: string;
    stages: { id: Id; name: string; position: number; criteria: string }[];
  }[];
  cards: {
    id: Id;
    laneId: Id;
    stageId: Id;
    title: string;
    summary: string;
    companyId: Id | null;
    link: 'this_chat' | 'other_chat';
    needsText: boolean;
    createdFromMessageKey: string | null;
    lastMessageAt: IsoTime | null;
  }[];
  proposals: { id: Id; laneId: Id; title: string; summary: string; openedByMessageKey: string; messageCount: number }[];
  participants: {
    contactId: Id;
    userKey: string;
    displayName: string;
    companyIds: Id[];
    roleCategory: string;
    dealsAbout: string;
  }[];
  companies: { id: Id; name: string; aliases: string[]; why: 'participant' | 'named' | 'card' | 'text' }[];
  roleCategories: string[];
}

export interface ModelDecision {
  disposition: 'none' | 'attach' | 'create' | 'join';
  cardId: Id | null;
  proposalId: Id | null;
  laneId: Id | null;
  title: string | null;
  summary: string | null;
  cardCompanyId: Id | null;
  cardCompanyName: string | null;
  confidence: number;
  reason: string;
  move: { toStageId: Id; criterion: string; evidenceMessageIds: Id[]; confidence: number } | null;
  contacts: {
    contactId: Id;
    companyId: Id | null;
    companyName: string | null;
    companyConfidence: number;
    roleCategory: string | null;
    dealsAbout: string | null;
    roleConfidence: number;
    evidenceMessageIds: Id[];
  }[];
  mentions: { companyId: Id | null; name: string; confidence: number }[];
}

export interface ScriptDecision {
  disposition: ModelDecision['disposition'];
  card: string | null;
  proposal: string | null;
  lane: string | null;
  title: string | null;
  summary: string | null;
  cardCompany: string | null;
  confidence: number;
  reason: string;
  move: { toStage: string; criterion: string; evidenceMessageKeys: string[]; confidence: number } | null;
  contacts: {
    userKey: string;
    company: string | null;
    companyConfidence: number;
    roleCategory: string | null;
    dealsAbout: string | null;
    roleConfidence: number;
    evidenceMessageKeys: string[];
  }[];
  mentions: { company: string; confidence: number }[];
}

export type ScriptLine =
  | { messageKey: string; version: number; decision: ScriptDecision }
  | { messageKey: string; version: number; raw: unknown };

export type ModelBlocked =
  | 'no_model'
  | 'model_config_missing'
  | 'model_endpoint_blocked'
  | 'model_unauthorised'
  | 'model_configuration_invalid';

export interface ModelConfig {
  provider: 'scripted' | 'openai' | null;
  name: string | null;
  apiKey: string | null;
  scriptPath: string | null;
  timeoutMs: number;
  maxOutputTokens: number;
  maxAttempts: 1 | 2;
}

export interface OpenAIResponseRequest {
  model: string;
  input: { role: 'system' | 'user'; content: string }[];
  text: { format: { type: 'json_schema'; name: 'kanban_decision'; strict: true; schema: Record<string, unknown> } };
  max_output_tokens: number;
  store: false;
}

export interface OpenAIResponsesPort {
  create(
    request: OpenAIResponseRequest,
    options: { signal: AbortSignal; timeoutMs: number; maxResponseBytes: number },
  ): Promise<unknown>;
}

export type ModelResponseFailure =
  | 'refusal'
  | 'incomplete'
  | 'schema_invalid'
  | 'unsupported_schema'
  | 'context_limit'
  | 'unauthorised';

export class ModelResponseError extends Error {
  readonly code: ModelResponseFailure;
  constructor(code: ModelResponseFailure) {
    super(code);
    this.name = 'ModelResponseError';
    this.code = code;
  }
}
