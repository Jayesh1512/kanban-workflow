import type { CardSummary, Id, IsoTime, LaneView } from './index.ts';

export type WorkflowWorkstream = 'buyer' | 'provider' | 'integration' | 'others';
export type WorkflowStage = 'to_be_started' | 'work_in_progress' | 'integrations' | 'blocked' | 'completed' | 'archive';
export interface WorkflowFields {
  workstream: WorkflowWorkstream;
  nextAction: string | null;
  followUpAt: IsoTime | null;
  blockedReason: string | null;
  buyerId: string | null;
}
export interface WorkflowTicket extends WorkflowFields {
  card: CardSummary;
  summary: string;
  workflowStage: WorkflowStage;
  version: number;
}
export interface WorkflowBoard {
  lane: LaneView | null;
  tickets: WorkflowTicket[];
  stages: { key: WorkflowStage; id: Id | null; name: string }[];
  automatic: boolean;
  confidenceThreshold: number;
  timeZone: string;
}
export interface WorkflowPriorities {
  asOf: IsoTime;
  overdue: WorkflowTicket[];
  dueToday: WorkflowTicket[];
  blocked: WorkflowTicket[];
  upcoming: WorkflowTicket[];
}
