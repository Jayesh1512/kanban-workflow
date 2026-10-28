import type { SqlExecutor } from '../shared/ports.js';

export const MEETING_SCHEMA_VERSION = 'meeting.v1' as const;
export interface FathomSpeaker { display_name: string; matched_calendar_invitee_email?: string | null }
export interface FathomTranscriptSegment { speaker: FathomSpeaker; text: string; timestamp: string }
export interface FathomAssignee { name: string | null; email: string | null; team?: string | null }
export interface FathomAction {
  description: string; user_generated?: boolean; completed: boolean;
  recording_timestamp?: string | null; recording_playback_url?: string | null; assignee?: FathomAssignee | null;
}
export interface FathomInvitee { name?: string | null; email?: string | null; email_domain?: string | null; is_external: boolean }
export interface FathomMeeting {
  recording_id: number; title: string; created_at: string;
  meeting_title?: string | null; meeting_type?: string | null;
  url?: string | null; share_url?: string | null; transcript_language?: string | null;
  scheduled_start_time?: string | null; scheduled_end_time?: string | null;
  recording_start_time?: string | null; recording_end_time?: string | null;
  recorded_by?: { name?: string | null; email?: string | null; email_domain?: string | null; team?: string | null } | null;
  calendar_invitees?: FathomInvitee[];
  transcript?: FathomTranscriptSegment[] | null;
  default_summary?: { template_name?: string | null; markdown_formatted: string | null } | null;
  action_items?: FathomAction[] | null;
  [key: string]: unknown;
}
export interface FathomPage { items: FathomMeeting[]; next_cursor: string | null; limit?: number | null }
export type ContentStatus = 'available' | 'unavailable';
export type ExportState = 'queued' | 'dispatched' | 'created' | 'unknown' | 'failed' | 'canceled' | 'retired' | 'none';
export interface MeetingCustomer { id: string; name: string; method: 'manual' | 'domain'; state: 'confirmed' }
export interface MeetingAction {
  id: string; meetingId: string; version: number; description: string;
  assignee: { name: string | null; email: string | null; team: string | null } | null;
  timestamp: string | null; playbackUrl: string | null; completed: boolean;
  sourceState: 'current' | 'retired' | 'ambiguous'; sourceRevision: number;
  exportState: ExportState; taskId: string | null; taskUrl: string | null;
}
export interface MeetingRecord {
  id: string; title: string; meetingType: string | null; language: string | null;
  source: { provider: 'fathom'; recordingId: string; url: string | null; origin: 'api' | 'manual' };
  startedAt: string | null; startBasis: 'recording' | 'scheduled' | 'unknown';
  scheduledStartAt: string | null; scheduledEndAt: string | null; recordingStartAt: string | null; recordingEndAt: string | null;
  sourceCreatedAt: string; observedAt: string; sourceRevision: number;
  recorder: { name: string | null; email: string | null } | null;
  participants: FathomInvitee[]; customers: MeetingCustomer[];
  customerState: 'confirmed' | 'unresolved' | 'ambiguous'; mappingVersion: number;
  summary: { status: ContentStatus; markdown: string | null; origin: 'fathom' };
  transcript: { status: ContentStatus; segmentCount: number; revision: number };
  actionsStatus: ContentStatus; actions: MeetingAction[];
  retiredActions?: MeetingAction[];
}
export interface MeetingEnvelope { schemaVersion: typeof MEETING_SCHEMA_VERSION; meeting: MeetingRecord }
export interface ListMeetingsInput {
  query?: string; customerId?: string; customerState?: 'unresolved' | 'ambiguous';
  from?: string; to?: string; recorder?: string; meetingType?: string;
  transcriptStatus?: ContentStatus; exportState?: ExportState;
  cursor?: string; limit?: number;
}
export interface MeetingListEnvelope { schemaVersion: typeof MEETING_SCHEMA_VERSION; items: MeetingRecord[]; nextCursor: string | null; total: number }
export interface TranscriptInput { id: string; revision?: number; cursor?: string; limit?: number }
export interface TranscriptEnvelope {
  schemaVersion: typeof MEETING_SCHEMA_VERSION; meetingId: string; revision: number; status: ContentStatus;
  items: FathomTranscriptSegment[]; nextCursor: string | null; total: number;
}
export interface CustomerListEnvelope {
  schemaVersion: typeof MEETING_SCHEMA_VERSION;
  items: { id: string; name: string; domains: string[]; meetingCount: number }[];
  unresolvedCount: number;
}
export interface IngestMeta { connectionKey?: string; observedAt?: string; origin?: 'api' | 'manual' }
export interface IngestResult { imported: number; unchanged: number }
export interface MeetingArchive {
  ingestPage(items: FathomMeeting[], meta?: IngestMeta, tx?: SqlExecutor): Promise<IngestResult>;
  list(input: ListMeetingsInput): Promise<MeetingListEnvelope>;
  get(id: string): Promise<MeetingEnvelope>;
  transcript(input: TranscriptInput): Promise<TranscriptEnvelope>;
  customers(): Promise<CustomerListEnvelope>;
  setCustomers(input: { id: string; companyIds: string[]; expectedVersion: number; reason: string }): Promise<MeetingEnvelope>;
}
/** Immutable creation snapshot; source owners are labels, never guessed Vikunja user IDs. */
export interface MeetingTaskSnapshot {
  actionId: string; actionVersion: number; meetingId: string; meetingTitle: string;
  title: string; description: string; customerNames: string[];
  sourceUrl: string | null; playbackUrl: string | null; timestamp: string | null;
  assignee: { name: string | null; email: string | null; team: string | null } | null;
  dueAt: null;
}
export interface MeetingRemoteTask { id: string; url: string | null }
export interface MeetingTaskPort {
  prepare(signal?: AbortSignal): Promise<void>;
  find(marker: string, signal?: AbortSignal): Promise<MeetingRemoteTask[]>;
  create(snapshot: MeetingTaskSnapshot, marker: string, signal?: AbortSignal): Promise<MeetingRemoteTask>;
  retire?(taskId: string, marker: string, signal?: AbortSignal): Promise<void>;
}
export interface MeetingConfig {
  enabled: boolean; apiKey: string | null; webhookSecret: string | null;
  pollIntervalMs: number; timeoutMs: number; internalDomains: string[]; projectId: string | null;
}
