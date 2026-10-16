import type { AnalysisInput, Extraction, JevDecision, ProviderProvenance } from '../../src/shared/domain.js';
import type { TelegramMessageInput } from '../../src/shared/ports.js';
import { addDays, EXTRACTION_VERSION, localDay } from '../../src/intelligence/validation.js';
import { JEV_RUBRIC_VERSION } from '../../src/intelligence/jev.js';

export const DEMO_KEY = 'demo:m5:cedar:v1';
export const CHAT_ID = '-1001';
export const SELF_ID = '99';
export const SOURCE_LABEL = 'SYNTHETIC AUTHORED DEMO: Telegram messages, extraction and Jev decision are fixtures; no live TG/OpenAI/Jev/Hermes call.';
export function messages(anchor: string): TelegramMessageInput[] {
  const authors = [
    { id: '7', name: 'Mira Sen', username: 'mira_cedar_demo', text: 'I am Mira Sen, CTO at Cedar Labs. Cedar Labs is reviewing AntSeed pricing and API documents for a buyer integration.' },
    { id: '8', name: 'Jo Rao', username: 'jo_cedar_demo', text: 'I am Jo Rao, engineering lead at Cedar Labs. I will review the AntSeed API documents tomorrow.' },
    { id: SELF_ID, name: 'AntSeed Demo', username: 'antseed_demo', text: 'AntSeed will send the pricing proposal and integration notes tomorrow. We are waiting on the Cedar Labs API review.' },
  ];
  return authors.map((a, i) => {
    const sentAt = new Date(Date.parse(anchor) - (2 - i) * 60000).toISOString();
    return { chatId: CHAT_ID, id: i + 1, senderId: a.id, sentAt, editedAt: null, text: `[SYNTHETIC DEMO] ${a.text}`, replyToId: i === 0 ? null : 1, sourceUrl: null,
      sender: { id: a.id, kind: 'user', names: [a.name], usernames: [a.username], visiblePhones: [], visibleEmails: [], observedAt: sentAt },
      peer: { id: CHAT_ID, kind: 'channel', names: ['Cedar Labs — SYNTHETIC DEMO'], usernames: [], visiblePhones: [], visibleEmails: [], observedAt: sentAt },
      forward: { isForwarded: false, sourceKind: 'own', originPeer: null, originName: null, originDate: null, originMessageId: null } };
  });
}
export function authoredExtraction(input: AnalysisInput): Extraction {
  const source = (messageId: number) => { const e = input.evidence.find((e) => e.messageId === messageId); if (!e) throw new Error('Demo source evidence absent'); return e; };
  const first = source(1), second = source(2), third = source(3), ids = [first.id, second.id, third.id];
  const date = (messageId: number) => {
    const e = source(messageId), m = input.messages.find((m) => m.id === messageId)!;
    return { kind: 'commitment' as const, originalText: 'tomorrow', relativeTo: m.sentAt, timezone: input.timezone, resolvedAt: null, localDate: addDays(localDay(m.sentAt, input.timezone), 1), precision: 'date' as const, ambiguous: false, evidenceIds: [e.id] };
  };
  return { companyCandidates: [{ companyId: null, canonicalName: 'Cedar Labs', confidence: 1, evidenceIds: [first.id] }],
    companies: [{ canonicalName: 'Cedar Labs', aliases: [], domains: [], buyerIds: [], providerIds: [], evidenceIds: [first.id] }],
    contacts: [
      { telegramUserIds: ['7'], names: ['Mira Sen'], usernames: ['mira_cedar_demo'], phones: [], emails: [], affiliation: 'external', evidenceIds: [first.id], roles: [{ companyName: 'Cedar Labs', role: 'CTO', evidenceIds: [first.id] }] },
      { telegramUserIds: ['8'], names: ['Jo Rao'], usernames: ['jo_cedar_demo'], phones: [], emails: [], affiliation: 'external', evidenceIds: [second.id], roles: [{ companyName: 'Cedar Labs', role: 'engineering lead', evidenceIds: [second.id] }] },
    ], facts: [
      { localKey: 'antseed-notes', answersLocalKey: null, kind: 'commitment', text: 'AntSeed will send the pricing proposal and integration notes tomorrow', actor: { party: 'antseed', contactId: null, displayName: 'AntSeed' }, state: 'open', dates: [date(3)], evidenceIds: [third.id] },
      { localKey: 'cedar-review', answersLocalKey: null, kind: 'commitment', text: 'Jo Rao will review the AntSeed API documents tomorrow', actor: { party: 'external', contactId: null, displayName: 'Jo Rao' }, state: 'open', dates: [date(2)], evidenceIds: [second.id] },
    ], dates: [], summary: 'SYNTHETIC DEMO: Cedar Labs is reviewing pricing and API documents. AntSeed owes a pricing proposal and integration notes tomorrow; Jo owns the Cedar API review.', substantive: true, evidenceIds: ids };
}
export function authoredDecision(extraction: Extraction): JevDecision {
  return { relevance: 'company', companyMatch: { outcome: 'new_company', candidates: extraction.companyCandidates }, workstream: 'Buyer', urgency: 'high',
    lane: { outcome: 'propose', targetLane: 'Work in progress', reason: 'SYNTHETIC AUTHORED DECISION: Cedar Labs explicitly reports pricing/API review; actual integration has not begun. Pending operator approval only.', nextAction: 'Send Cedar Labs the pricing proposal and integration notes tomorrow.', evidenceIds: extraction.evidenceIds },
    model: 'authored-fixture/no-live-jev', diagnostics: { rubricVersion: JEV_RUBRIC_VERSION, answers: { company_match: { type: 'choice', choice: 'new_company', confidence: 1, probabilities: { new_company: 1, ambiguous: 0, none: 0 } } } } };
}
export function authoredProvenance(provider: 'openai' | 'vercel', completedAt: string): ProviderProvenance {
  return { provider, model: provider === 'openai' ? 'authored-fixture/no-live-openai' : 'authored-fixture/no-live-jev', requestId: 'synthetic-authored-demo:no-upstream-request', schemaVersion: provider === 'openai' ? EXTRACTION_VERSION : JEV_RUBRIC_VERSION, completedAt, usage: { synthetic: true, networkCalls: 0 } };
}
