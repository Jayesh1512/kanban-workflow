import type { Actor, ChatRef, Id, IsoTime, ReviewChange, ReviewKind, ReviewProposal, ReviewWhy } from './index.ts';

export interface StageView {
  id: Id;
  name: string;
  position: number;
  criteria: string;
}

export interface LaneView {
  id: Id;
  name: string;
  sop: string;
  version: number;
  position: number;
  archived: boolean;
  stages: StageView[];
}

export interface CardSummary {
  id: Id;
  laneId: Id;
  stageId: Id;
  title: string;
  company: { id: Id; name: string } | null;
  contacts: { id: Id; name: string }[];
  teammates: { id: Id; name: string }[];
  lastMessageAt: IsoTime | null;
  lastChangeBy: 'agent' | 'teammate' | 'credential';
  fromHistory: boolean;
  archived: boolean;
  hasGap: boolean;
}

export interface CardDetail extends CardSummary {
  summary: string;
  messages: MessageView[];
  history: LogEntry[];
  references: KnownCompanyPanel[];
}

export interface BoardView {
  version: number;
  lanes: (LaneView & { cards: CardSummary[] })[];
  openReviewCount: number;
}

export interface ContactSummary {
  id: Id;
  name: string;
  companies: { id: Id; name: string }[];
  roleCategory: string;
  dealsAbout: string;
}

export interface ContactView extends ContactSummary {
  identities: { id: Id; channel: string; displayName: string; handle: string | null }[];
  roleEvidence: MessageView[];
  companyEvidence: { companyId: Id; messages: MessageView[] }[];
  chats: { id: Id; title: string; lastMessageAt: IsoTime | null }[];
  lastConversationAt: IsoTime | null;
  recentMessages: MessageView[];
  cards: CardSummary[];
}

export interface KnownCompanyPanel {
  referenceId: Id;
  company: { id: Id; name: string };
  message: MessageView;
  contacts: ContactSummary[];
  lastConversationAt: IsoTime | null;
  openCards: CardSummary[];
}

export interface CompanyView {
  id: Id;
  name: string;
  aliases: string[];
  contacts: ContactSummary[];
  chats: { id: Id; title: string; teammates: { id: Id; name: string }[]; lastMessageAt: IsoTime | null }[];
  lastConversationAt: IsoTime | null;
  recentMessages: MessageView[];
  cards: CardSummary[];
  referencesOut: KnownCompanyPanel[];
  referencedBy: { referenceId: Id; company: { id: Id; name: string } | null; message: MessageView }[];
}

export interface CompanyMatch {
  match: 'exact' | 'alias' | 'similar' | 'none';
  companyId: Id | null;
  score: number;
}

export interface CompanyCandidate {
  id: Id;
  name: string;
  aliases: string[];
  why: 'participant' | 'named' | 'card' | 'text';
}

export interface MessageView {
  id: Id;
  chatId: Id;
  chatTitle: string;
  channel: string;
  sender: { identityId: Id; name: string; contactId: Id | null; teammateId: Id | null };
  direction: 'in' | 'out';
  sentAt: IsoTime;
  text: string | null;
  media: string | null;
  replyToId: Id | null;
  edited: boolean;
  deleted: boolean;
  fromHistory: boolean;
  cardId: Id | null;
  teammateIds: Id[];
}

export interface MessageHit {
  message: MessageView;
  companies: { id: Id; name: string }[];
  card: { id: Id; title: string } | null;
}

export interface ReviewItemView {
  id: Id;
  kind: ReviewKind;
  why: ReviewWhy;
  confidence: number;
  reason: string;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  chat: { id: Id; title: string } | null;
  proposal: ReviewProposal;
  describe: string;
  messages: MessageView[];
  canAccept: boolean;
  allowedChanges: ReviewChange['to'][];
}

export type SubjectKind =
  | 'lane'
  | 'card'
  | 'message'
  | 'contact'
  | 'company'
  | 'reference'
  | 'review'
  | 'setting'
  | 'teammate'
  | 'credential'
  | 'account'
  | 'chat'
  | 'mcp';

export interface LogEntryInput {
  action: string;
  subjectKind: SubjectKind;
  subjectId: Id | null;
  before?: unknown;
  after?: unknown;
  reason?: string;
  messageIds?: Id[];
  decisionId?: Id | null;
  correctsId?: Id;
  followsHumanOverride?: boolean;
}

export interface LogEntry {
  id: Id;
  at: IsoTime;
  actor: { kind: Actor['kind']; id: Id | null; name: string };
  action: string;
  subjectKind: SubjectKind;
  subjectId: Id | null;
  before: unknown;
  after: unknown;
  reason: string;
  messageIds: Id[];
  correctsId: Id | null;
  followsHumanOverride: boolean;
  redacted: boolean;
}

export interface ChatListing {
  key: string;
  chatId: Id | null;
  kind: ChatRef['kind'];
  title: string;
  latestAt: IsoTime | null;
  decision: 'included' | 'excluded' | 'withdrawn' | 'undecided';
  agreementOutOfDate: boolean;
  withdrawnBy: string | null;
  withdrawnAt: IsoTime | null;
}

export interface ChatCounts {
  connected: boolean;
  undecidedRecent: number | null;
  agreementOutOfDate: number;
}

export interface AccountView {
  id: Id;
  teammateId: Id;
  channel: string;
  label: string;
  state: string;
  gaps: { chatId: Id; chatTitle: string; fromTime: IsoTime; toTime: IsoTime; abandoned: boolean }[];
}
