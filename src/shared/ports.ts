import type { FastifyInstance } from 'fastify';
import type { QueryResult, QueryResultRow } from 'pg';
import type {
  AnalysisInput, Chat, Company, CompanyCandidate, Contact, ContactCompanyRole, Evidence, Extraction,
  HistoryCursor, ISODateTime, JevDecision, Json, Lane, Message, Mutation, Page, PageInput,
  Priority, Proposal, RemoteId, ServiceStatus, TelegramChatId, TelegramMessageId, TelegramUserId, Ticket, UUID, Workstream,
  BusinessFact, ContactDetail, ExtractionCheckpoint, LiveCheckpoint, ProviderProvenance,
} from './domain.js';
import type { CorrectMappingInput, DecideProposalInput, ProposeLaneInput, SetInclusionInput, UpdateActionsInput, UpdateFactInput } from './schemas.js';
import type { OutreachService } from './outreach-domain.js';

export interface Clock { now(): Date }
export interface SqlExecutor {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}
/** Every callback uses ONE checked-out connection; rollback on throw; no network I/O inside. */
export interface Database extends SqlExecutor {
  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  /** Same checked-out session across nested query/transaction/lock calls; remote I/O stays outside transactions. */
  withSessionLock<T>(key: string, work: (session: SqlExecutor, signal: AbortSignal) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export interface RuntimeConfig {
  http: { host: string; port: number };
  databaseUrl: string;
  timezone: string;
  aiEnvPath: string;
  telegram: { apiId: number | null; apiHash: string | null; sessionPath: string; historyBatchSize: number; historyMaxBatches: number; discoveryBatchSize?: number };
  vikunja: { baseUrl: string; apiToken: string | null; username: string; password: string | null; projectTitle: string; publicUrl?:string; timeoutMs?: number };
  extraction: { provider: 'openai'; model: string; apiKey: string | null; timeoutMs: number; maxAttempts: number; maxOutputTokens: number };
  jev: { provider: 'vercel' | 'openai'; endpoint: string; model: string; apiKey: string | null; timeoutMs: number; maxAttempts: number };
}
export type LoadRuntimeConfig = (env?: NodeJS.ProcessEnv) => Promise<RuntimeConfig>;
export interface OperationsStatus {
  components: Record<string, ServiceStatus>;
  telegramLogin: TelegramLoginState;
  accountBound: boolean;
  imports: HistoryCursor[];
  replayPending: number;
  analysisPending: number;
  proposalsPending: number;
  configuration: { aiEnvReadable: boolean; telegramConfigured: boolean; extractionConfigured: boolean; jevConfigured: boolean };
}
export interface ApplicationModule {
  name: string;
  register(app: FastifyInstance): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>; // safe after partial start; must be idempotent
  status(): Promise<ServiceStatus>;
}
export interface PlatformServices { db: Database; config: RuntimeConfig; telegram: TelegramPort; vikunja: VikunjaPort; clock: Clock; chats: ChatService; ingestion: IngestionStore; control: ControlBus }
export interface PlatformModule extends ApplicationModule { services: PlatformServices; operationsStatus(): Promise<OperationsStatus> }
export type CreatePlatformModule = (config: RuntimeConfig) => Promise<PlatformModule>;
export type CreateWorkflowModule = (services: PlatformServices) => Promise<ApplicationModule>;

export type TelegramLoginState =
  | { state: 'unconfigured' | 'disconnected' | 'connecting' | 'ready'; detail: string | null }
  | { state: 'code_required'; phone: string; delivery: string; resendAt: ISODateTime | null }
  | { state: 'password_required'; hint: string | null }
  | { state: 'error'; code: string; detail: string; retryAt: ISODateTime | null };
export type TelegramLoginInput = { step: 'phone'; phone: string } | { step: 'code'; code: string } | { step: 'password'; password: string };
export interface TelegramDialog { id: TelegramChatId; kind: Chat['kind']; title: string; username: string | null; archived: boolean; latestMessageAt?: ISODateTime | null }
export type TelegramMessageInput = Omit<Message, 'version' | 'deletedAt'>;
export type TelegramEvent =
  | { type: 'message' | 'edit'; message: TelegramMessageInput }
  | { type: 'delete'; chatId: TelegramChatId | null; messageIds: TelegramMessageId[]; observedAt: ISODateTime }
  | { type: 'connection'; status: ServiceStatus }
  | { type: 'replay_required'; chatId: TelegramChatId | null; reason: 'reconnect' | 'too_long' | 'queue_failure' };
export interface HistoryBatch {
  messages: TelegramMessageInput[];
  next: { messageId: TelegramMessageId; date: ISODateTime } | null;
  complete: boolean;
}
export interface ControlMessage {
  chatId: TelegramChatId;
  messageId: TelegramMessageId;
  senderId: TelegramUserId | null;
  replyToMessageId: TelegramMessageId | null;
  text: string;
  sentAt: ISODateTime;
}
export interface TelegramPort {
  status(): Promise<ServiceStatus>;
  loginState(): Promise<TelegramLoginState>;
  submitLogin(input: TelegramLoginInput): Promise<TelegramLoginState>;
  authorizedSelf(): Promise<TelegramUserId | null>;
  discoverDialogs(): AsyncIterable<TelegramDialog>; // includes archived, bounded pages internally
  getHistory(chatId: TelegramChatId, cursor: HistoryCursor, limit: number): Promise<HistoryBatch>;
  subscribe(handler: (event: TelegramEvent) => Promise<void>): () => void; // adapter MUST await via queue
  configureControlChat(input: { operationKey: string } & ({ chatId: TelegramChatId } | { createPrivateSupergroup: true; title: string })): Promise<ControlSetup>;
  reconcileControlSetup(operationKey: string): Promise<ControlSetup>;
  sendControlMessage(input: { chatId: TelegramChatId; text: string; replyToMessageId?: TelegramMessageId; randomId: string }): Promise<{ messageId: TelegramMessageId }>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
export interface ControlSetup { operationKey: string; marker: string; state: 'prepared' | 'remote_unknown' | 'configured' | 'conflict' | 'failed'; chat: TelegramDialog | null; lastError: string | null }
export interface ControlBus {
  subscribeOwner?(owner: 'operational'|'outreach', handler:(message:ControlMessage)=>Promise<void>, validateDelivery?:(proposalId:string)=>Promise<boolean>):()=>void;
  subscribe(handler: (message: ControlMessage) => Promise<void>): () => void;
  enqueueProposal(tx: SqlExecutor, input: { proposalId: UUID; chatId: TelegramChatId; text: string }): Promise<void>; // same proposal transaction
}
export interface BoardBinding {
  projectId: RemoteId;
  viewId: RemoteId;
  buckets: Record<Lane, RemoteId>;
  labels: Record<Workstream, RemoteId>;
}
export interface RemoteTask { id: RemoteId; projectId: RemoteId; bucketId: RemoteId; title: string; description: string; updatedAt: ISODateTime }
export interface VikunjaPort {
  status(): Promise<ServiceStatus>;
  ensureBoard(): Promise<BoardBinding>; // reconcile existing project/view/buckets/labels, no blind POST
  ensureTask(input: { ticketId: UUID; title: string; description: string; workstream: Workstream }): Promise<RemoteTask>; // stable backend marker; starts To be started
  getTask(taskId: RemoteId): Promise<RemoteTask | null>; // include bucket for managed view
  updateTaskDetails(input: { taskId: RemoteId; title: string; description: string; workstream: Workstream }): Promise<RemoteTask>;
  moveTask(input: { taskId: RemoteId; projectId: RemoteId; viewId: RemoteId; targetBucketId: RemoteId }): Promise<void>; // workflow apply or first projection restoring the durable saved lane
  retireTask?(input: { ticketId: UUID; taskId: RemoteId }): Promise<void>; // projector-only removal after source approval is withdrawn/missing
}
export interface ChatService {
  list(input: PageInput): Promise<Page<Chat>>;
  setInclusion(input: SetInclusionInput): Promise<Chat>;
  importStatus(chatId: TelegramChatId): Promise<HistoryCursor>;
  requestImport(input: { chatId: TelegramChatId; maxBatches: number; batchSize: number; idempotencyKey: string }): Promise<HistoryCursor>;
  mappingCandidates(chatId: TelegramChatId): Promise<CompanyCandidate[]>;
  correctMapping(input: CorrectMappingInput): Promise<Chat>;
}
export interface IngestionStore {
  bindAccount(selfId: TelegramUserId): Promise<void>; // first binding or same self only; mismatch requires new dataset/session volume
  upsertDialog(dialog: TelegramDialog): Promise<Chat>; // new discovery waits undecided for control-group intake approval; preserve existing selection
  ingest(event: TelegramEvent): Promise<void>; // persists message/version + analysis job atomically; control chat routed separately
  claimHistory(chatId: TelegramChatId, workerId: string, leaseMs: number): Promise<HistoryCursor | null>;
  commitHistoryBatch(chatId: TelegramChatId, expectedPolicyVersion: number, expectedGeneration: number, batch: HistoryBatch): Promise<HistoryCursor>;
  getCursor(chatId: TelegramChatId): Promise<HistoryCursor>;
  getLiveCheckpoint(chatId: TelegramChatId): Promise<LiveCheckpoint>;
  commitReplay(input: { chatId: TelegramChatId; expectedPolicyVersion: number; expectedGeneration: number; messages: TelegramMessageInput[]; highWaterMessageId: TelegramMessageId | null }): Promise<LiveCheckpoint>;
}
export interface CompanyWrite {
  idempotencyKey: string;
  canonicalName: string;
  aliases: string[];
  domains: string[];
  workstream: Workstream | null;
  summary: string;
  buyerIds: string[];
  providerIds: string[];
  evidenceIds: UUID[];
}
export interface ContactWrite extends Omit<Contact, 'id' | 'version'> { idempotencyKey: string; roles: Array<Omit<ContactCompanyRole, 'contactId'>> }
export interface RecordsService {
  listCompanies(input: PageInput & { query?: string }): Promise<Page<Company>>;
  getCompany(id: UUID): Promise<Company>;
  createCompany(input: CompanyWrite): Promise<Company>;
  updateCompany(id: UUID, expectedVersion: number, input: CompanyWrite): Promise<Company>;
  listContacts(input: PageInput & { companyId?: UUID }): Promise<Page<ContactDetail>>;
  getContact(id: UUID): Promise<ContactDetail>;
  createContact(input: ContactWrite): Promise<ContactDetail>;
  updateContact(id: UUID, expectedVersion: number, input: ContactWrite): Promise<ContactDetail>;
  listTickets(input: PageInput & { companyId?: UUID; lane?: Lane }): Promise<Page<Ticket>>;
  getTicket(id: UUID): Promise<Ticket>;
  ensureTicket(chatId: TelegramChatId): Promise<Ticket>; // legacy only; CRM-first mode requires a Telegram-approved concrete action
  getContext(input: { ticketId: UUID; limit: number }): Promise<{ ticket: Ticket; chat: Chat; company: Company | null; contacts: ContactDetail[]; evidence: Evidence[]; messages: Message[]; facts: BusinessFact[]; outreach?: import('./domain.js').OutreachContext }>;
  getEvidence(ids: UUID[]): Promise<Evidence[]>;
  updateActions(input: UpdateActionsInput): Promise<Ticket>;
  listFacts(input: PageInput & { ticketId: UUID }): Promise<Page<BusinessFact>>;
  updateFact(input: UpdateFactInput): Promise<BusinessFact>;
  priorities(input: { date?: string; timezone?: string; limit: number }): Promise<Priority[]>;
}
export type ProviderResult<T> =
  | { ok: true; value: T; provenance: ProviderProvenance }
  | { ok: false; code: 'unconfigured' | 'entitlement' | 'rate_limited' | 'timeout' | 'invalid_response' | 'unavailable'; retryable: boolean; retryAt: ISODateTime | null; detail: string };
export interface ExtractionPort { extract(input: AnalysisInput, signal?: AbortSignal): Promise<ProviderResult<Extraction>>; status(): Promise<ServiceStatus> }
export interface JevPort { decide(input: AnalysisInput & { extraction: Extraction }, signal?: AbortSignal): Promise<ProviderResult<JevDecision>>; status(): Promise<ServiceStatus> }
export interface AnalysisJob {
  id: UUID;
  readonly claimToken: string; // immutable per attempt; persisted in analysis_jobs.worker_id
  chatId: TelegramChatId;
  policyVersion: number;
  mappingVersion: number;
  status: 'pending' | 'running' | 'provider_unavailable' | 'retry' | 'completed' | 'cancelled';
  attempts: number;
  leaseUntil: ISODateTime | null;
  retryAt: ISODateTime | null;
  lastError: string | null;
}
export interface AnalysisQueue {
  claim(input: { workerId: string; leaseMs: number }): Promise<AnalysisJob | null>; // distinct token per claim, including same worker/job reclaim
  loadInput(jobId: UUID): Promise<AnalysisInput>;
  getExtraction(jobId: UUID): Promise<ExtractionCheckpoint | null>;
  saveExtraction(checkpoint: ExtractionCheckpoint, claimToken: string): Promise<void>; // persist before Jev; validate versions/hash and live claim
  complete(jobId: UUID, decision: JevDecision, provenance: ProviderProvenance, claimToken: string): Promise<void>; // uses saved extraction; recheck versions and live claim
  fail(jobId: UUID, error: Extract<ProviderResult<never>, { ok: false }>, claimToken: string): Promise<void>;
  replayUnavailable(input: { idempotencyKey: string; chatId?: TelegramChatId; includeCompletedUnmapped?: boolean; includeCompletedDecisions?: boolean }): Promise<{ queued: number }>;
}
export interface ProposalService {
  propose(input: ProposeLaneInput): Promise<Proposal>;
  get(id: UUID): Promise<Proposal>;
  list(input: PageInput & { ticketId?: UUID; decision?: Proposal['decision'] }): Promise<Page<Proposal>>;
  decide(input: DecideProposalInput): Promise<{ proposal: Proposal; replacement: Proposal | null }>;
  handleControlReply(message: ControlMessage): Promise<void>; // reply correlation; no sender allowlist
  applyNext(): Promise<Mutation | null>;
  reconcile(mutationId: UUID): Promise<Mutation>; // read remote before retry; exactly one local stage increment
}
/** Transaction-scoped persistence semantics owned by workflow, never implemented by an adapter. */
export interface MutationStore {
  prepare(proposalId: UUID): Promise<Mutation>; // lock ticket/proposal, validate versions/evidence, unique proposal
  claim(input: { workerId: string; leaseMs: number }): Promise<Mutation | null>;
  markRemoteUnknown(id: UUID, detail: string): Promise<void>;
  confirmRemote(id: UUID, actualBucketId: RemoteId): Promise<Mutation>;
  commit(id: UUID): Promise<Proposal>; // atomic ticket/version+proposal+mutation; idempotent
}
export interface DomainServices { chats: ChatService; records: RecordsService; proposals: ProposalService; analysis: AnalysisQueue; outreach: OutreachService }
export interface IdempotencyStore {
  run<T extends Json>(scope: string, key: string, request: Json, work: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}
