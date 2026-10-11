import type { FixtureLine, MovementReplayLine, ScriptLine } from '../src/contracts/index.ts';

// Architecture 3.15 file shapes; these are eval file types, not product interfaces.
export interface ReplaySetup {
  teammates: { username: string; account: string }[];
  lanes: { name: string; sop: string; stages: { name: string; criteria: string }[] }[];
  included: { account: string; chatKey: string; company: string | null }[];
  settings: {
    review_threshold: number;
    require_agreement: boolean;
    role_categories: string[];
    keep_deleted_text: boolean;
  };
}
export interface ReplayLabels {
  messages: Record<string, { work: boolean; lane: string | null; card: string | null }>;
  cards: Record<
    string,
    {
      lane: string;
      chatKeys: string[];
      createdByMessageKey: string;
      company: string | null;
      transitions: { toStage: string; messageKey: string }[];
    }
  >;
  contacts: Record<
    string,
    { company: string; roleCategory: string; hasCompanyEvidence: boolean; hasRoleEvidence: boolean }
  >;
  mentions: { messageKey: string; company: string; known: boolean }[];
  companies: { name: string; variants: string[] }[];
  injections: string[];
}
export interface ReplayDataset {
  recording: FixtureLine[];
  setup: ReplaySetup;
  script: ScriptLine[];
  movement: MovementReplayLine[];
  labels: ReplayLabels;
}
export type RecordedMessage = Extract<FixtureLine, { t: 'message' }>;
