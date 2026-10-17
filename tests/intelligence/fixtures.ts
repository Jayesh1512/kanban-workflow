import type { AnalysisInput, Extraction, JevDecision, ProviderProvenance } from '../../src/shared/domain.js';
import { buildJevRequest, JEV_RUBRIC_VERSION } from '../../src/intelligence/jev.js';
import { EXTRACTION_VERSION } from '../../src/intelligence/validation.js';

export const evidenceId = '00000000-0000-4000-8000-000000000001';
export const jobId = '00000000-0000-4000-8000-000000000002';
export const sourceText = 'I am Mira, CTO at Cedar Labs. AntSeed will send notes tomorrow.';
const snapshot = { id: '7', kind: 'user' as const, names: ['Mira'], usernames: ['mira'], visiblePhones: [], visibleEmails: [], observedAt: '2026-10-17T00:00:00.000Z' };
export function inputFixture(): AnalysisInput {
  return { jobId, accountSelfId: '99', chat: { id: '-1001', kind: 'supergroup', title: 'Cedar Labs', username: null, archived: false, inclusion: 'included', isControl: false, policyVersion: 0, mappingStatus: 'unresolved', companyId: null, mappingVersion: 0 },
    messages: [{ chatId: '-1001', id: 1, senderId: '7', sentAt: '2026-10-16T20:00:00.000Z', editedAt: null, deletedAt: null, text: sourceText, replyToId: null, sourceUrl: null, version: 1,
      sender: snapshot, peer: { ...snapshot, id: '-1001', kind: 'channel', names: ['Cedar Labs'] }, forward: { isForwarded: false, sourceKind: 'own', originPeer: null, originName: null, originDate: null, originMessageId: null } }],
    evidence: [{ id: evidenceId, chatId: '-1001', messageId: 1, messageVersion: 1, excerpt: sourceText, sourceUrl: null, observedAt: '2026-10-16T20:00:00.000Z', invalidatedAt: null }], companies: [], ticket: null, timezone: 'Asia/Kolkata' };
}
export function extractionFixture(id = evidenceId): Extraction {
  const date = { kind: 'commitment' as const, originalText: 'tomorrow', relativeTo: '2026-10-16T20:00:00.000Z', timezone: 'Asia/Kolkata', resolvedAt: null, localDate: '2026-10-18', precision: 'date' as const, ambiguous: false, evidenceIds: [id] };
  return { companyCandidates: [{ companyId: null, canonicalName: 'Cedar Labs', confidence: 0.98, evidenceIds: [id] }], companies: [{ canonicalName: 'Cedar Labs', aliases: [], domains: [], buyerIds: [], providerIds: [], evidenceIds: [id] }],
    contacts: [{ telegramUserIds: ['7'], names: ['Mira'], usernames: ['mira'], phones: [], emails: [], affiliation: 'external', evidenceIds: [id], roles: [{ companyName: 'Cedar Labs', role: 'CTO', evidenceIds: [id] }] }],
    facts: [{ localKey: 'notes', answersLocalKey: null, kind: 'commitment', text: 'AntSeed will send notes tomorrow', actor: { party: 'antseed', contactId: null, displayName: 'AntSeed' }, state: 'open', dates: [date], evidenceIds: [id] }], dates: [], summary: 'Cedar Labs discussion; AntSeed owes notes.', substantive: true, evidenceIds: [id] };
}
export function responseFixture(input = inputFixture(), extraction = extractionFixture()) {
  const request = buildJevRequest({ ...input, extraction }, 'typesafe-ai/jev');
  const chosen: Record<string, string> = { relevance: 'company', company_match: 'new_company', workstream: 'Buyer', lane: 'no_change' };
  const answers = Object.fromEntries(Object.entries(request.questions).map(([id, q]) => [id, q.type === 'noul' ? { type: 'noul', noul: 0.98 }
    : q.type === 'score' ? { type: 'score', score: 1, confidence: 1, legend: Object.fromEntries(q.criteria.map((s, i) => [String(i), s])), probabilities: Object.fromEntries(q.criteria.map((_, i) => [String(i), i === 1 ? 1 : 0])) }
      : { type: 'choice', choice: chosen[id], confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map((key) => [key, key === chosen[id] ? 1 : 0])) }]));
  return { model: 'typesafe-ai/jev', answers, usage: { input_tokens: 100, output_tokens: 30 } };
}
export function decisionFixture(id = evidenceId): JevDecision {
  return { relevance: 'company', companyMatch: { outcome: 'new_company', candidates: extractionFixture(id).companyCandidates }, workstream: 'Buyer', urgency: 'normal',
    lane: { outcome: 'no_change', reason: 'Discussion only', evidenceIds: [id] }, model: 'typesafe-ai/jev', diagnostics: { rubricVersion: JEV_RUBRIC_VERSION,
      answers: { company_match: { type: 'choice', choice: 'new_company', confidence: 1, probabilities: { new_company: 1, ambiguous: 0, none: 0 } } } } };
}
export function provenance(provider: 'openai' | 'vercel' = 'openai'): ProviderProvenance { return { provider, model: provider === 'openai' ? 'gpt-6.1-sol' : 'typesafe-ai/jev', requestId: 'synthetic-request', schemaVersion: provider === 'openai' ? EXTRACTION_VERSION : JEV_RUBRIC_VERSION, completedAt: '2026-10-17T00:00:00.000Z', usage: { input_tokens: 100, output_tokens: 30 } }; }
