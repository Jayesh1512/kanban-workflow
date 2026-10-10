import type { CompanyRef, Id } from './index.ts';

export type ReviewKind =
  | 'new_card'
  | 'attach'
  | 'move'
  | 'is_work'
  | 'contact_company'
  | 'contact_role'
  | 'name_company'
  | 'model_failed';

export type ReviewWhy =
  | 'low_confidence'
  | 'cross_chat'
  | 'cross_lane'
  | 'human_override'
  | 'similar_name'
  | 'model_failed';

export type HeldUse =
  | { use: 'contact_company'; contactId: Id; evidenceMessageIds: Id[] }
  | { use: 'reference'; messageId: Id };

export type ReviewProposal =
  | {
      kind: 'new_card';
      laneId: Id;
      title: string;
      summary: string;
      companyId: Id | null;
      move: { toStageId: Id; criterion: string } | null;
    }
  | { kind: 'attach'; cardId: Id; summary: string | null }
  | { kind: 'move'; cardId: Id; toStageId: Id; criterion: string }
  | { kind: 'is_work' }
  | { kind: 'contact_company'; contactId: Id; company: CompanyRef }
  | { kind: 'contact_role'; contactId: Id; category: string; dealsAbout: string }
  | { kind: 'name_company'; name: string; companyId: Id; held: HeldUse[] }
  | { kind: 'model_failed' };

export type ReviewChange =
  | { to: 'new_card'; laneId: Id; title: string; summary: string; stageId: Id | null }
  | { to: 'card'; cardId: Id }
  | { to: 'stage'; stageId: Id }
  | { to: 'company'; company: string }
  | { to: 'role'; category: string; dealsAbout: string };
