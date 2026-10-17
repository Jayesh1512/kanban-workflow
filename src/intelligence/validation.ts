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
  const timestamps = sources.map((e) => {
    const m = input.messages.find((m) => m.id === e.messageId && m.chatId === e.chatId);
    return m?.forward.isForwarded && m.forward.originDate ? m.forward.originDate : m?.sentAt;
  });
  if (!timestamps.some((t) => t && Date.parse(t) === Date.parse(d.relativeTo))) throw new Error('Date anchor does not match evidence');
  const phrase = d.originalText.toLowerCase().trim();
  if (!phrase || !sources.some((e) => e.excerpt.toLowerCase().includes(phrase))) throw new Error('Date phrase absent from cited source');
  if (/^(kal|कल)[.! ]*$/.test(phrase) && (d.precision !== 'unresolved' || !d.ambiguous)) throw new Error('Ambiguous kal requires unresolved precision');
  let delta: number | null = null;
  if (/\btomorrow\b|कल.*(?:करेंगे|भेजेंगे|भेजूँगा|भेजूंगा|भेजेगा|करूँगा|करूंगा|दूँगा|दूंगा)|\bkal\b.*\b(?:dunga|karenge|bhejunga)\b/.test(phrase)) delta = 1;
  else if (/\byesterday\b|\bkal\b.*\b(?:tha|kiya|diya)\b/.test(phrase)) delta = -1;
  else if (/\btoday\b|\baaj\b|आज/.test(phrase)) delta = 0;
  const expectedDay = delta === null ? null : addDays(localDay(d.relativeTo, d.timezone), delta);
  if (d.precision !== 'unresolved' && expectedDay && (d.precision === 'date' ? d.localDate : localDay(d.resolvedAt!, d.timezone)) !== expectedDay) throw new Error('Relative date does not match message day');
  const calendar = phrase.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
  if (d.precision === 'date' && calendar && d.localDate !== calendar) throw new Error('Date differs from sourced calendar day');
  if (d.precision === 'instant') {
    const full = phrase.match(/\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:\d{2})/i)?.[0];
    if (full) { if (Date.parse(full) !== Date.parse(d.resolvedAt!)) throw new Error('Instant differs from sourced timestamp'); }
    else {
      if (!expectedDay && !calendar) throw new Error('Instant requires a supported sourced calendar day');
      if (calendar && localDay(d.resolvedAt!, d.timezone) !== calendar) throw new Error('Instant differs from sourced calendar day');
      // A calendar day never supplies a clock time. Require an explicit clock in
      // the actual date phrase, then verify its local wall time independently.
      const clock = /\b(\d{1,2})(?::(\d{2})(?::(\d{2}))?\s*(am|pm)?|\s*(am|pm))\b/i.exec(phrase);
      const named = /\b(noon|midnight)\b/.exec(phrase);
      const spoken = /(?:^|\s)(\d{1,2})\s*(?:baje|बजे)(?=\s|$|[.!।])/iu.exec(phrase);
      const hindiHours: Record<string, number> = { एक: 1, दो: 2, तीन: 3, चार: 4, पाँच: 5, पांच: 5, छह: 6, सात: 7, आठ: 8, नौ: 9, दस: 10, ग्यारह: 11, बारह: 12 };
      const hindi = /(एक|दो|तीन|चार|पाँच|पांच|छह|सात|आठ|नौ|दस|ग्यारह|बारह)\s*बजे/u.exec(phrase);
      if (!clock && !named && !spoken && !hindi) throw new Error('Instant precision requires an explicit sourced time');
      let hour = clock ? Number(clock[1]) : spoken ? Number(spoken[1]) : hindi ? hindiHours[hindi[1]!]! : named![1] === 'noon' ? 12 : 0;
      const morning = /\bsubah\b|सुबह/u.test(phrase), evening = /\b(?:shaam|sham|dopahar)\b|शाम|दोपहर/u.test(phrase), night = /\braat\b|रात/u.test(phrase);
      if (Number(morning) + Number(evening) + Number(night) > 1) throw new Error('Ambiguous sourced clock qualifier');
      const meridiem = clock?.[4] ?? clock?.[5] ?? (spoken || hindi ? morning || (night && hour === 12) ? 'am' : evening || night ? 'pm' : null : null);
      if ((spoken || hindi) && !meridiem && hour <= 12) throw new Error('Ambiguous spoken clock requires unresolved precision');
      if (meridiem) { if (hour < 1 || hour > 12) throw new Error('Invalid sourced clock'); hour = hour % 12 + (meridiem.toLowerCase() === 'pm' ? 12 : 0); }
      const minute = Number(clock?.[2] ?? 0), second = Number(clock?.[3] ?? 0);
      if (hour > 23 || minute > 59 || second > 59) throw new Error('Invalid sourced clock');
      const timezone = /\b(?:utc|gmt)\b/.test(phrase) ? 'UTC' : d.timezone;
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(d.resolvedAt!));
      const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
      if (get('hour') !== hour || get('minute') !== minute || get('second') !== second || new Date(d.resolvedAt!).getUTCMilliseconds() !== 0) throw new Error('Instant differs from sourced clock time');
    }
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
    const author = (m: (typeof sourceMessages)[number]) => m.forward.isForwarded ? m.forward.originPeer : m.sender;
    const recipients = sourceMessages.filter(m => input.accountSelfId && m.senderId === input.accountSelfId && !m.forward.isForwarded && input.chat.kind === 'user' && m.peer.kind === 'user' && m.peer.id === input.chat.id && m.peer.id !== input.accountSelfId).map(m => m.peer);
    const authors = [...sourceMessages.map(author).filter((p) => p?.kind === 'user'), ...recipients];
    const userIds = new Set(authors.map((p) => p!.id));
    if (c.telegramUserIds.some((id) => !userIds.has(id))) throw new Error('Contact identity absent from user snapshots');
    if (new Set(c.telegramUserIds).size > 1) throw new Error('Multiple Telegram identities require separate sourced contacts');
    const normalize = (text: string) => text.trim().replace(/^@/, '').toLowerCase();
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const targeted = authors.filter((p) => c.telegramUserIds.length ? c.telegramUserIds.includes(p!.id ?? '') : [...p!.names, ...p!.usernames].some((v) => [...c.names, ...c.usernames].some((name) => normalize(name) === normalize(v))));
    const snapshots = targeted.flatMap((p) => p ? [p] : []);
    const quoted = c.evidenceIds.filter((id) => { const e = validEvidence.get(id)!; const m = sourceMessages.find((m) => m.id === e.messageId && m.chatId === e.chatId)!; return !c.telegramUserIds.length || c.telegramUserIds.includes(author(m)?.id ?? ''); }).map((id) => validEvidence.get(id)!.excerpt);
    const selfName = (name: string, quote: string) => new RegExp(`(?:\\b(?:i am|i'm|my name is|this is|main)\\s+|मैं\\s+)${escape(name)}(?:\\b|$)`, 'iu').test(quote)
      || new RegExp(`^(?:(?:hi|hello|hey)\\b[^\\n.!?;]{0,80}?,\\s*)?${escape(name)}\\s+here\\s+(?:from|at)\\s+\\S`, 'iu').test(quote.trim());
    const originNames = c.telegramUserIds.length ? [] : sourceMessages.filter((m) => m.forward.isForwarded && !m.forward.originPeer).flatMap((m) => m.forward.originName ? [m.forward.originName] : []);
    if (c.names.some((name) => ![...snapshots.flatMap((p) => p.names), ...originNames].some((v) => normalize(v) === normalize(name)) && !quoted.some((quote) => selfName(name, quote)))) throw new Error('Contact name absent from target identity evidence');
    const attributed = (quote: string, m: (typeof sourceMessages)[number]) => {
      const p = author(m);
      const matchesAuthor = p?.kind === 'user' && (c.telegramUserIds.length ? c.telegramUserIds.includes(p.id ?? '') : snapshots.some((s) => s.id === p.id));
      const named = c.names.some((name) => new RegExp(`${escape(name)}(?:['’]s)?\\s+(?:is|works|says|email|phone|username|contact|cto|ceo|founder|engineer|at|from)\\b`, 'iu').test(quote));
      const self = /\b(?:i am|i'm|i work|my (?:email|phone|username)|main)\b|मैं/iu.test(quote);
      return named || (self && (matchesAuthor || (!c.telegramUserIds.length && c.names.some((name) => selfName(name, m.text)))));
    };
    const clauses = c.evidenceIds.flatMap((id) => {
      const e = validEvidence.get(id)!; const m = sourceMessages.find((m) => m.id === e.messageId && m.chatId === e.chatId)!;
      return e.excerpt.split(/[.!?]\s+|[;\n]/).filter((q) => attributed(q, m));
    });
    const explicitlyAssigned = (field: string, label: string) => clauses.some((q) => {
      const quotedField = escape(field).replace(/^@/, '@?');
      const selfAssignment = new RegExp(`\\bmy ${label}(?: number| address)?(?: is|:)?\\s+${quotedField}(?=$|[\\s,.;])`, 'iu');
      const namedAssignment = c.names.some((name) => new RegExp(`${escape(name)}['’]s ${label}(?: number| address)?(?: is|:)?\\s+${quotedField}(?=$|[\\s,.;])`, 'iu').test(q));
      const matchingSelf = sourceMessages.some((m) => { const p = author(m); return m.text.includes(q) && (c.telegramUserIds.length ? c.telegramUserIds.includes(p?.id ?? '') : snapshots.some((s) => s.id === p?.id) || c.names.some((name) => selfName(name, m.text))); });
      return (matchingSelf && selfAssignment.test(q)) || namedAssignment;
    });
    if (c.usernames.some((name) => !snapshots.some((p) => p.usernames.some((v) => normalize(v) === normalize(name))) && !explicitlyAssigned(`@${normalize(name)}`, 'username'))) throw new Error('Contact username absent from target identity evidence');
    for (const field of [...c.phones, ...c.emails]) {
      if (!snapshots.some((p) => [...p.visiblePhones, ...p.visibleEmails].includes(field)) && !explicitlyAssigned(field, '(?:phone|email|contact)')) throw new Error('Contact detail not visible in target identity evidence');
    }
    for (const r of c.roles) {
      check(r.evidenceIds);
      const roleQuotes = r.evidenceIds.flatMap((id) => validEvidence.get(id)!.excerpt.split(/[.!?]\s+|[;\n]/));
      if (!r.role.trim() || !roleQuotes.some((q) => q.toLowerCase().includes(r.companyName.toLowerCase()) && q.toLowerCase().includes(r.role.toLowerCase()) && sourceMessages.some((m) => m.text.includes(q) && attributed(q, m)))) throw new Error('Role lacks explicit identity-attributed source');
    }
    const atCompany = (company: string) => clauses.some((q) => new RegExp(`(?:\\b(?:at|from|of)\\s+|\\b(?:company|team) is\\s+)${escape(company)}(?:\\b|$)`, 'iu').test(q));
    // An authored introduction can explicitly state affiliation even if the
    // extractor omitted a redundant company/role object. Partial display names
    // are accepted here only when bound to that exact visible user profile.
    const introducedCompanies = c.evidenceIds.flatMap((id) => {
      const e = validEvidence.get(id)!; const m = sourceMessages.find((m) => m.id === e.messageId && m.chatId === e.chatId)!; const p = author(m);
      if (!p || !snapshots.some((s) => s.id === p.id)) return [];
      const names = p.names.flatMap((name) => [name, name.trim().split(/\s+/)[0]!]).filter((name) => name.length > 1);
      return names.flatMap((name) => {
        const match = new RegExp(`^${escape(name)}\\s+(?:from|at)\\s+([^.!?;\\n]{1,100}?)\\s+here\\b`, 'iu').exec(e.excerpt.trim()); return match ? [match[1]!.trim()] : [];
      });
    });
    // The dataset explicitly binds this exact account to AntSeed. That trusted
    // identity does not require a repeated self-introduction in every message.
    const connectedAccount = !!input.accountSelfId && c.telegramUserIds.length === 1 && c.telegramUserIds[0] === input.accountSelfId;
    if (c.affiliation === 'internal' && !connectedAccount && !introducedCompanies.some((name) => normalize(name) === 'antseed') && !atCompany('AntSeed')) throw new Error('Internal affiliation lacks identity-attributed AntSeed evidence');
    if (c.affiliation === 'external' && !introducedCompanies.some((name) => normalize(name) !== 'antseed') && !c.roles.some((r) => r.companyName.toLowerCase() !== 'antseed') && !value.companies.some((company) => company.canonicalName.toLowerCase() !== 'antseed' && atCompany(company.canonicalName))) throw new Error('External affiliation lacks identity-attributed company evidence');
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
