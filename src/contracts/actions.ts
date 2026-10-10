import type { CompanyMatch, Id, IsoTime, ReviewKind, ReviewProposal, ReviewWhy, SetBy } from './index.ts';

export type CompanyRef = { id: Id } | { name: string };

export type Action =
  | {
      type: 'card.create';
      laneId: Id;
      title: string;
      summary: string;
      chatId: Id;
      messageId: Id;
      companyId: Id | null;
      fromHistory: boolean;
    }
  | {
      type: 'message.attach';
      messageId: Id;
      cardId: Id;
      title: string | null;
      summary: string | null;
      companyId: Id | null;
    }
  | { type: 'card.move'; cardId: Id; toStageId: Id; criterion: string; evidenceMessageIds: Id[] }
  | { type: 'contact.set_company'; contactId: Id; company: CompanyRef; evidenceMessageIds: Id[] }
  | { type: 'contact.set_role'; contactId: Id; category: string; dealsAbout: string; evidenceMessageIds: Id[] }
  | { type: 'reference.record'; toCompanyId: Id; messageId: Id };

export interface GuardFacts {
  threshold: number;
  message: {
    id: Id;
    chatId: Id;
    sentAt: IsoTime;
    fromHistory: boolean;
    cardLink: { cardId: Id | null; setBy: SetBy } | null;
  };
  activeLaneIds: Id[];
  stages: { id: Id; laneId: Id }[];
  cards: {
    id: Id;
    laneId: Id;
    archived: boolean;
    linkedToChat: boolean;
    offeredToChat: boolean;
    stageHumanSetAt: IsoTime | null;
    textSetBy: SetBy;
    needsText: boolean;
    companySetBy: SetBy | null;
  }[];
  proposals: { id: Id; status: 'open' | 'accepted' | 'changed' | 'dismissed'; resultCardId: Id | null }[];
  participants: { contactId: Id; roleSetBy: SetBy; hasHumanCompany: boolean }[];
  shownCompanyIds: Id[];
  matches: { name: string; match: CompanyMatch }[];
  removedReferenceCompanyIds: Id[];
  validEvidenceIds: Id[];
  roleCategories: string[];
}

export type Outcome =
  | { do: 'apply'; action: Action; followsHumanOverride: boolean }
  | {
      do: 'review';
      kind: ReviewKind;
      groupKey: string;
      chatId: Id | null;
      why: ReviewWhy;
      proposal: ReviewProposal;
      confidence: number;
    }
  | { do: 'pending_mention'; name: string; confidence: number }
  | { do: 'refuse'; why: string };

export interface WriteOpts {
  reason?: string;
  decisionId?: Id | null;
  setBy?: SetBy;
  correctsLogId?: Id;
}
