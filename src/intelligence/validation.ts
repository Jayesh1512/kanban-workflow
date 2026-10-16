import { z } from 'zod';
import type { AnalysisInput, DateFact, Extraction } from '../shared/domain.js';
import { dateFactSchema, timestampSchema, uuidSchema } from '../shared/schemas.js';

export const EXTRACTION_VERSION = 'extraction.v1';
const text = z.string().max(16000);
const strings = z.array(z.string().min(1).max(2000)).max(200);
const evidenceIds = z.array(uuidSchema).max(200);
const actor = z.strictObject({ party: z.enum(['antseed', 'external', 'unknown']), contactId: uuidSchema.nullable().describe('Only a pre-existing UUID in input.ticket.contactIds; null when absent. Never generate an ID or use a Telegram numeric ID.'), displayName: text.nullable() });
const dateShape = z.strictObject({ kind: z.enum(['commitment', 'follow_up', 'eta']), originalText: text,
  relativeTo: timestampSchema, timezone: z.string(), resolvedAt: timestampSchema.nullable(), localDate: z.iso.date().nullable(),
  precision: z.enum(['instant', 'date', 'unresolved']), ambiguous: z.boolean(), evidenceIds });
export const extractionSchema = z.strictObject({
  companyCandidates: z.array(z.strictObject({ companyId: uuidSchema.nullable(), canonicalName: text, confidence: z.number().min(0).max(1), evidenceIds })).max(100),
  companies: z.array(z.strictObject({ canonicalName: z.string().min(1).max(500), aliases: strings, domains: strings, buyerIds: strings, providerIds: strings, evidenceIds })).max(100),
  contacts: z.array(z.strictObject({ telegramUserIds: z.array(z.string().regex(/^[1-9]\d*$/)).max(100), names: strings, usernames: strings,
    phones: strings, emails: strings, affiliation: z.enum(['internal', 'external', 'unknown']), evidenceIds,
    roles: z.array(z.strictObject({ companyName: text, role: text, evidenceIds })).max(100) })).max(200),
  facts: z.array(z.strictObject({ localKey: z.string().min(1).max(100), answersLocalKey: z.string().nullable(),
    kind: z.enum(['fact', 'action', 'question', 'blocker', 'commitment']), text, actor,
    state: z.enum(['open', 'answered', 'completed', 'withdrawn']), dates: z.array(dateShape).max(100), evidenceIds })).max(200),
  dates: z.array(dateShape).max(200), summary: text, substantive: z.boolean(), evidenceIds,
});

export function localDay(instant: string | Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function addDays(day: string, days: number): string {
  const value = new Date(`${day}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10);
}
export function validateDate(value: DateFact, input: AnalysisInput): DateFact {
  const d = dateFactSchema.parse(value);
  new Intl.DateTimeFormat('en', { timeZone: d.timezone });
  if (d.timezone !== input.timezone || (d.ambiguous && d.precision !== 'unresolved')) throw new Error('Invalid date interpretation');
  const sources = input.evidence.filter((e) => d.evidenceIds.includes(e.id));
  const timestamps = sources.map((e) => input.messages.find((m) => m.id === e.messageId && m.chatId === e.chatId)?.sentAt);
  if (!timestamps.some((t) => t && Date.parse(t) === Date.parse(d.relativeTo))) throw new Error('Date anchor does not match evidence');
  const phrase = d.originalText.toLowerCase();
  if (d.precision === 'date') {
    let delta: number | null = null;
    if (/\btomorrow\b|कल.*(?:करेंगे|भेजेंगे)|\bkal\b.*\b(?:dunga|karenge|bhejunga)\b/.test(phrase)) delta = 1;
    else if (/\byesterday\b|\bkal\b.*\b(?:tha|kiya|diya)\b/.test(phrase)) delta = -1;
    else if (/\btoday\b|\baaj\b|आज/.test(phrase)) delta = 0;
    if (delta !== null && d.localDate !== addDays(localDay(d.relativeTo, d.timezone), delta)) throw new Error('Relative date does not match message day');
    if (/^(kal|कल)[.! ]*$/.test(phrase)) throw new Error('Ambiguous kal requires unresolved precision');
  }
  return d;
}

/** Validate source relationships independently of a provider's schema guarantee. */
export function validateExtraction(raw: unknown, input: AnalysisInput): Extraction {
  const value = extractionSchema.parse(raw);
  if (input.chat.inclusion !== 'included' || input.chat.isControl) throw new Error('Chat is not eligible');
  const validEvidence = new Map(input.evidence.filter((e) => {
    const m = input.messages.find((m) => m.id === e.messageId && m.chatId === e.chatId);
    return e.chatId === input.chat.id && !e.invalidatedAt && m && !m.deletedAt && m.version === e.messageVersion && e.excerpt.length > 0 && m.text.includes(e.excerpt);
  }).map((e) => [e.id, e]));
  const check = (ids: string[], required = true) => { if ((required && ids.length === 0) || ids.some((id) => !validEvidence.has(id))) throw new Error('Unsupported evidence reference'); };
  check(value.evidenceIds, value.substantive || value.companies.length > 0 || value.facts.length > 0 || value.contacts.length > 0);
  for (const c of value.companies) {
    check(c.evidenceIds);
    if (!c.evidenceIds.some((id) => validEvidence.get(id)!.excerpt.toLowerCase().includes(c.canonicalName.toLowerCase()))) throw new Error('Company name absent from cited source');
    const quotes = c.evidenceIds.map((id) => validEvidence.get(id)!.excerpt).join('\n');
    if ([...c.aliases, ...c.domains].some((s) => !quotes.toLowerCase().includes(s.toLowerCase())) || [...c.buyerIds, ...c.providerIds].some((s) => !quotes.includes(s))) throw new Error('Company attribute absent from cited source');
  }
  for (const c of value.companyCandidates) {
    check(c.evidenceIds);
    if (c.companyId && !input.companies.some((known) => known.id === c.companyId)) throw new Error('Unknown company candidate');
  }
  for (const c of value.contacts) {
    check(c.evidenceIds);
    const sourceMessages = c.evidenceIds.map((id) => { const e = validEvidence.get(id)!; return input.messages.find((m) => m.id === e.messageId && m.chatId === e.chatId)!; });
    const userIds = new Set(sourceMessages.flatMap((m) => (m.forward.isForwarded ? [m.forward.originPeer] : [m.sender]).filter((p) => p?.kind === 'user').map((p) => p!.id)));
    if (c.telegramUserIds.some((id) => !userIds.has(id))) throw new Error('Contact identity absent from user snapshots');
    if (c.affiliation === 'internal' && !c.evidenceIds.some((id) => /antseed/i.test(validEvidence.get(id)!.excerpt))) throw new Error('Internal affiliation lacks AntSeed evidence');
    for (const field of [...c.phones, ...c.emails]) {
      if (!sourceMessages.some((m) => m.text.includes(field) || [...m.sender.visiblePhones, ...m.sender.visibleEmails].includes(field))) throw new Error('Contact detail not visible in evidence');
    }
    for (const r of c.roles) {
      check(r.evidenceIds);
      const quotes = r.evidenceIds.map((id) => validEvidence.get(id)!.excerpt.toLowerCase());
      if (!r.role.trim() || !quotes.some((q) => q.includes(r.companyName.toLowerCase()) && q.includes(r.role.toLowerCase()))) throw new Error('Role lacks explicit source');
    }
  }
  const keys = new Set(value.facts.map((f) => f.localKey));
  if (keys.size !== value.facts.length) throw new Error('Duplicate local fact keys');
  for (const f of value.facts) {
    check(f.evidenceIds);
    if (f.answersLocalKey && (!keys.has(f.answersLocalKey) || f.answersLocalKey === f.localKey)) throw new Error('Unknown answering fact reference');
    if (f.actor.contactId && !input.ticket?.contactIds.includes(f.actor.contactId)) throw new Error('Unknown actor contact');
    for (const date of f.dates) { check(date.evidenceIds); validateDate(date, input); }
  }
  for (const date of value.dates) { check(date.evidenceIds); validateDate(date, input); }
  return value;
}
