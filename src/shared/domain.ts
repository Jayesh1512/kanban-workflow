/** Wire IDs stay strings: Telegram int64 / SQL bigint must never round through JS number. */
export type UUID = string;
export type TelegramChatId = string; // mtcute marked peer ID, decimal, includes -100 channel prefix
export type TelegramUserId = string;
export type TelegramMessageId = number; // positive int32, scoped to chat
export type RemoteId = string; // Vikunja int64
export type ISODateTime = string; // RFC3339 with offset; persist as timestamptz
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export const LANES = ['To be started', 'Work in progress', 'Integrations', 'Blocked', 'Archived', 'Completed'] as const;
export type Lane = (typeof LANES)[number];
export const WORKSTREAMS = ['Buyer', 'Provider', 'Integration', 'Others'] as const;
export type Workstream = (typeof WORKSTREAMS)[number];
export type Urgency = 'low' | 'normal' | 'high' | 'urgent';
export type MappingStatus = 'unresolved' | 'ambiguous' | 'confirmed' | 'non_company';
export type Inclusion = 'undecided' | 'included' | 'excluded';

export interface Chat {
  id: TelegramChatId;
  kind: 'user' | 'group' | 'supergroup' | 'channel';
  title: string;
  username: string | null;
  archived: boolean;
  inclusion: Inclusion;
  isControl: boolean;
  policyVersion: number;
  mappingStatus: MappingStatus;
  companyId: UUID | null;
  mappingVersion: number;
}
export interface HistoryCursor {
  chatId: TelegramChatId;
  nextMessageId: TelegramMessageId | null;
  nextDate: ISODateTime | null;
  status: 'pending' | 'running' | 'paused' | 'complete' | 'error';
  importedCount: number;
  lastError: string | null;
  updatedAt: ISODateTime;
  generation: number;
  leaseUntil: ISODateTime | null;
}
export interface LiveCheckpoint { chatId: TelegramChatId; highWaterMessageId: TelegramMessageId | null; reconciledAt: ISODateTime | null; replayRequired: boolean; generation: number }
export interface PeerSnapshot { id: string | null; kind: 'user' | 'chat' | 'channel' | 'anonymous'; names: string[]; usernames: string[]; visiblePhones: string[]; visibleEmails: string[]; observedAt: ISODateTime }
export interface ForwardProvenance {
  isForwarded: boolean;
  sourceKind: 'own' | 'forwarded' | 'unknown';
  originPeer: PeerSnapshot | null;
  originName: string | null;
  originDate: ISODateTime | null;
  originMessageId: TelegramMessageId | null;
}
export interface Message {
  chatId: TelegramChatId;
  id: TelegramMessageId;
  senderId: TelegramUserId | null;
  sender: PeerSnapshot;
  peer: PeerSnapshot;
  sentAt: ISODateTime;
  editedAt: ISODateTime | null;
  deletedAt: ISODateTime | null;
  text: string;
  replyToId: TelegramMessageId | null;
  sourceUrl: string | null;
  version: number;
  forward: ForwardProvenance;
}
export interface Evidence {
  id: UUID;
  chatId: TelegramChatId;
  messageId: TelegramMessageId;
  messageVersion: number;
  excerpt: string;
  sourceUrl: string | null;
  observedAt: ISODateTime;
  invalidatedAt: ISODateTime | null;
}
export interface Company {
  id: UUID;
  canonicalName: string;
  aliases: string[];
  domains: string[];
  workstream: Workstream | null;
  summary: string;
  buyerIds: string[];
  providerIds: string[];
  evidenceIds: UUID[];
  version: number;
}
export interface Contact {
  id: UUID;
  telegramUserIds: TelegramUserId[];
  names: string[];
  usernames: string[];
  phones: string[];
  emails: string[];
  affiliation: 'internal' | 'external' | 'unknown';
  evidenceIds: UUID[];
  version: number;
}
export interface ContactCompanyRole {
  contactId: UUID;
  companyId: UUID;
  role: string;
  evidenceIds: UUID[]; // explicit affiliation evidence, never participation alone
}
export interface ContactDetail extends Contact { roles: ContactCompanyRole[] }
export interface Ticket {
  id: UUID;
  chatId: TelegramChatId;
  kind: 'company' | 'contact_prospect';
  companyId: UUID | null;
  vikunjaTaskId: RemoteId | null;
  lane: Lane;
  stageVersion: number;
  previousActiveLane: Lane | null;
  workstream: Workstream;
  summary: string;
  nextAction: string | null;
  followUpAt: ISODateTime | null;
  etaAt: ISODateTime | null;
  latestSubstantiveAt: ISODateTime | null;
  blockers: string[];
  contactIds: UUID[];
  evidenceIds: UUID[];
  actionsVersion: number;
  actionsSource: 'manual' | 'inferred';
  trackingState: 'active' | 'suspended';
}
export interface CompanyCandidate {
  companyId: UUID | null; // null = proposed new company, never automatic confirmed mapping
  canonicalName: string;
  confidence: number;
  evidenceIds: UUID[];
}
export interface DateFact {
  kind: 'commitment' | 'follow_up' | 'eta';
  originalText: string;
  relativeTo: ISODateTime; // source message timestamp, never worker wall clock
  timezone: string;
  resolvedAt: ISODateTime | null;
  localDate: string | null; // YYYY-MM-DD when source gives a day but no time
  precision: 'instant' | 'date' | 'unresolved';
  ambiguous: boolean;
  evidenceIds: UUID[];
}
export interface FactActor { party: 'antseed' | 'external' | 'unknown'; contactId: UUID | null; displayName: string | null }
export interface BusinessFact {
  id: UUID;
  kind: 'fact' | 'action' | 'question' | 'blocker' | 'commitment';
  text: string;
  actor: FactActor;
  state: 'open' | 'answered' | 'completed' | 'withdrawn';
  answersFactId: UUID | null;
  dates: DateFact[];
  evidenceIds: UUID[];
  version: number;
  source: 'manual' | 'inferred';
}
export interface ExtractedCompany {
  canonicalName: string;
  aliases: string[];
  domains: string[];
  buyerIds: string[];
  providerIds: string[];
  evidenceIds: UUID[];
}
export interface Extraction {
  companyCandidates: CompanyCandidate[];
  companies: ExtractedCompany[];
  contacts: Array<Omit<Contact, 'id' | 'version'> & { roles: Array<{ companyName: string; role: string; evidenceIds: UUID[] }> }>;
  facts: Array<Omit<BusinessFact, 'id' | 'version' | 'answersFactId' | 'source'> & { localKey: string; answersLocalKey: string | null }>;
  dates: DateFact[];
  summary: string;
  substantive: boolean;
  evidenceIds: UUID[];
}
export interface AnalysisInput {
  jobId: UUID;
  accountSelfId?: TelegramUserId;
  chat: Chat;
  messages: Message[];
  evidence: Evidence[];
  companies: Company[];
  ticket: Ticket | null;
  timezone: string;
}
export interface OutreachContext {
  accountSelfId: TelegramUserId | null;
  coverage: 'captured_messages';
  initiatedBy: 'antseed' | 'other' | 'unknown';
  lastOutgoingAt: ISODateTime | null;
  lastIncomingAt: ISODateTime | null;
  waitingForReply: boolean;
}
export type LaneRecommendation =
  | { outcome: 'propose'; targetLane: Lane; evidenceIds: UUID[]; reason: string; nextAction: string | null }
  | { outcome: 'no_change' | 'uncertain'; reason: string; evidenceIds: UUID[] };
export interface JevDecision {
  relevance: 'company' | 'non_company' | 'uncertain';
  outreach?: { outcome: 'enquiry' | 'not_enquiry' | 'uncertain'; probability: number; evidenceIds: UUID[] };
  companyMatch: { outcome: 'matched'; companyId: UUID; confidence: number } | { outcome: 'ambiguous' | 'new_company' | 'none'; candidates: CompanyCandidate[] };
  workstream: Workstream | null;
  urgency: Urgency | null;
  lane: LaneRecommendation;
  model: string;
  diagnostics: JevDiagnostics;
}
export type JevAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number };
export interface JevDiagnostics { rubricVersion: string; answers: Record<string, JevAnswer>; native?: Json }
export interface ProviderProvenance { provider: 'openai' | 'vercel'; model: string; requestId: string | null; schemaVersion: string; completedAt: ISODateTime; usage: Json; validation?:{omittedContactNames:number;omittedContactAffiliations?:number} }
export interface ExtractionCheckpoint { jobId: UUID; extraction: Extraction; provenance: ProviderProvenance; inputHash: string }
export type ProposalDecision = 'pending' | 'approved' | 'rejected' | 'corrected';
export type ApplyState = 'not_requested' | 'queued' | 'applying' | 'reconciling' | 'applied' | 'stale' | 'failed';
export interface Proposal {
  id: UUID;
  ticketId: UUID;
  sourceLane: Lane;
  sourceStageVersion: number;
  sourceMappingVersion: number;
  sourcePolicyVersion: number;
  targetLane: Lane;
  evidenceIds: UUID[];
  reason: string;
  nextAction: string | null;
  origin: 'jev' | 'openai' | 'hermes' | 'manual';
  decision: ProposalDecision;
  applyState: ApplyState;
  correctionOf: UUID | null;
  decidedAt: ISODateTime | null;
  appliedAt: ISODateTime | null;
  lastError: string | null;
}
export interface Mutation {
  id: UUID;
  proposalId: UUID;
  taskId: RemoteId;
  sourceBucketId: RemoteId;
  targetBucketId: RemoteId;
  state: 'prepared' | 'remote_unknown' | 'remote_confirmed' | 'committed' | 'conflict';
  attempts: number;
  leaseUntil: ISODateTime | null;
  lastError: string | null;
}
export interface Priority {
  ticket: Ticket;
  urgency: Urgency;
  reasons: Array<'commitment' | 'overdue' | 'upcoming' | 'unanswered' | 'blocked'>;
  evidenceIds: UUID[];
}
export interface Page<T> { items: T[]; nextCursor: string | null }
export interface PageInput { cursor?: string; limit?: number }
export type ServiceState = 'unconfigured' | 'connecting' | 'ready' | 'degraded' | 'unavailable';
export interface ServiceStatus {
  state: ServiceState;
  code: string | null; // e.g. provider_entitlement, login_required, flood_wait
  detail: string | null; // sanitized, no upstream credentials/raw config
  checkedAt: ISODateTime;
}
