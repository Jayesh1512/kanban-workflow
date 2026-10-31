import type { BusinessFact, Lane, Workstream, ForwardProvenance } from './domain.js';
export const SALES_STAGES = [
    { id: 'lead', label: 'Lead / Prospect' },
    { id: 'qualification', label: 'Qualification' },
    { id: 'negotiation', label: 'Negotiation' },
    { id: 'won', label: 'Deal Won' },
    { id: 'archived', label: 'Archived' },
] as const;
export type SalesStage = typeof SALES_STAGES[number]['id'];
export interface OutreachListInput {
    cursor?: string;
    limit?: number;
    query?: string;
    stage?: SalesStage;
    disposition?: 'pipeline' | 'context_review';
}
export interface OutreachRelationship {
    id: string;
    kind: 'company' | 'contact_prospect';
    companyId: string | null;
    displayName: string;
    title: string;
    /** `Next: … · ETA: …`; the stage is already shown by the column. */
    nextStep: string;
    summary: string;
    workstream: Workstream | null;
    acceptedStage: SalesStage | null;
    displayStage: SalesStage | null;
    stageBasis: 'accepted' | 'provisional' | 'unknown';
    stageReason: string | null;
    stageVersion: number;
    evidenceRevision: number;
    identityVersion?: number;
    actionsVersion?: number;
    disposition: 'pipeline' | 'context_review';
    sourceCount: number;
    pendingSourceCount: number;
    latestSourceAt: string | null;
    reconciledAt: string | null;
    sourceState: 'current' | 'changed';
}
export interface OutreachContact {
    id: string;
    names: string[];
    usernames: string[];
    roles: string[];
    emails?: string[];
    phones?: string[];
    affiliation: 'internal' | 'external' | 'unknown';
    evidenceIds: string[];
}
export interface OutreachSource {
    id: string;
    kind: 'telegram' | 'email_report';
    chatId: string | null;
    ticketId: string | null;
    title: string;
    operationalLane: Lane | null;
    nextAction?: string | null;
    hasOutbound?: boolean;
    enrollmentState: 'pending' | 'active' | 'rejected' | 'suspended';
    eligible: boolean;
    sourceRevision: string;
    latestSourceAt: string | null;
}
export interface OutreachSourceContext extends OutreachSource {
    reportSummary?: string;
    reportNextAction?: string;
    contacts: OutreachContact[];
    facts: BusinessFact[];
    evidence: Array<{
        id: string;
        excerpt: string;
        sourceUrl: string | null;
        observedAt: string;
        sentAt?:string;
        author?:{id:string|null;party:'antseed'|'unknown';names:string[]};
        forward?:ForwardProvenance;
    }>;
    coverage: {
        evidenceLimit: number;
        factLimit: number;
        truncated: boolean;
        reportCheckedAt?:string;
        description?:string;
    };
}
export interface OutreachDetail {
    relationship: OutreachRelationship;
    activeSources: OutreachSourceContext[];
    pendingSources: OutreachSourceContext[];
    suspendedSources: OutreachSource[];
    limits: string[];
    actions?: OutreachAction[];
    workTickets?: Array<{ id: string; action: string | null; lane: Lane; vikunjaTaskId: string | null }>;
    publication?: {
        state: string;
        lastError: string | null;
        observedStage: string | null;
    } | null;
}
export interface OutreachService extends Partial<OutreachCommands> {
    list(input: OutreachListInput): Promise<{
        items: OutreachRelationship[];
        nextCursor: string | null;
    }>;
    get(id: string): Promise<OutreachDetail>;
}
export interface OutreachAction {
    id: string;
    text: string;
    actor: 'antseed' | 'external' | 'unknown';
    state: 'open' | 'completed' | 'cancelled';
    precision: 'none' | 'date' | 'instant';
    localDate: string | null;
    instant: string | null;
    timezone: string;
    version: number;
}
export interface OutreachCommands {
    proposeWork(input: unknown): Promise<Record<string, unknown>>;
    proposeRecordChange(kind: 'work_actions' | 'fact', input: unknown): Promise<unknown>;
    propose(input: unknown, origin?: 'manual' | 'hermes' | 'openai' | 'historical_policy'): Promise<Record<string, unknown>>;
    listProposals(input: unknown): Promise<{
        items: Record<string, unknown>[];
    }>;
    getProposal(id: string): Promise<Record<string, unknown>>;
    decide(input: unknown, source?: 'http' | 'telegram' | 'historical_policy'): Promise<Record<string, unknown>>;
    previewImport(input: unknown): Promise<Record<string, unknown>>;
    commitImport(id: string): Promise<Record<string, unknown>>;
    getImport(id: string): Promise<Record<string, unknown>>;
    updateActions(input: unknown): Promise<Record<string, unknown>>;
    assess(input: unknown, signal?: AbortSignal): Promise<Record<string, unknown>>;
    correctIdentity(input: unknown): Promise<Record<string, unknown>>;
    setMode(input: unknown): Promise<Record<string, unknown>>;
    status(): Promise<Record<string, unknown>>;
}
