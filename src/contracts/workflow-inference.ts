import type { Id, MovementChoice, MovementEvidence, MovementFailure, WorkflowFields, WorkflowStage } from './index.ts';

export type WorkflowAction =
  | 'outreach'
  | 'follow_up'
  | 'engineering_assessment'
  | 'run_test'
  | 'confirm_live'
  | 'resolve_blocker'
  | 'none';
export interface WorkflowValueCandidate {
  id: string;
  value: string;
  messageId: Id;
  quote: string;
}
export interface WorkflowInferenceRequest {
  requestId: string;
  snapshotHash: string;
  messageId: Id;
  chatId: Id;
  timeZone: string;
  ticket: (WorkflowFields & { id: Id; version: number; stage: WorkflowStage; title: string; summary: string }) | null;
  evidence: (MovementEvidence & { direction: 'in' | 'out' })[];
  dates: WorkflowValueCandidate[];
  buyerIds: WorkflowValueCandidate[];
}
export type WorkflowInferenceResult =
  | { kind: 'failed'; code: MovementFailure }
  | {
      kind: 'answered';
      requestId: string;
      snapshotHash: string;
      configuredModel: string;
      providerRequestId: string | null;
      choices: Record<string, MovementChoice>;
      supports: Record<string, MovementChoice>;
    };
