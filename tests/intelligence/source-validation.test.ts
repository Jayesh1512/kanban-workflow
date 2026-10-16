import { describe, expect, it } from 'vitest';
import { validateExtraction } from '../../src/intelligence/validation.js';
import { inputFixture, extractionFixture } from './fixtures.js';
function forwarded() {
  const input = inputFixture(); const original = { ...input.messages[0]!.sender, visiblePhones: ['+11111111111'], visibleEmails: ['origin@example.invalid'] };
  input.messages[0]!.forward = { isForwarded: true, sourceKind: 'forwarded', originPeer: original, originName: 'Mira', originDate: null, originMessageId: null };
  input.messages[0]!.sender = { ...original, id: '8', names: ['Forwarder'], usernames: ['forwarder'], visiblePhones: ['+22222222222'], visibleEmails: ['forwarder@example.invalid'] }; input.messages[0]!.senderId = '8';
  return input;
}
function text(input: ReturnType<typeof inputFixture>, source: string) { input.messages[0]!.text = source; input.evidence[0]!.excerpt = source; }
describe('independent identity and precision regressions (no providers)', () => {
  it('uses only the original target profile for forwarded identity details', () => {
    const input = forwarded(), value = extractionFixture(); value.contacts[0]!.phones = ['+11111111111']; value.contacts[0]!.emails = ['origin@example.invalid'];
    expect(validateExtraction(value, input).contacts[0]!.telegramUserIds).toEqual(['7']);
    for (const field of ['phones', 'emails', 'names', 'usernames'] as const) {
      const wrong = structuredClone(value); wrong.contacts[0]![field] = [({ phones: '+22222222222', emails: 'forwarder@example.invalid', names: 'Forwarder', usernames: 'forwarder' })[field]];
      expect(() => validateExtraction(wrong, input)).toThrow();
    }
  });
  it.each(['names', 'usernames', 'affiliation'])('rejects invented contact %s despite an unrelated AntSeed mention', (field) => {
    const value = extractionFixture(); if (field === 'names') value.contacts[0]!.names = ['Invented Person']; else if (field === 'usernames') value.contacts[0]!.usernames = ['invented_username']; else value.contacts[0]!.affiliation = 'internal';
    expect(() => validateExtraction(value, inputFixture())).toThrow();
  });
  it('does not borrow a second cited identity self-declaration for the first identity', () => {
    const input = inputFixture(); const next = structuredClone(input.messages[0]!); next.id = 2; next.sender = { ...next.sender, id: '8', names: ['Bob'], usernames: ['bob'] }; next.senderId = '8'; next.text = 'I am Bob. My email is bob@example.invalid.'; input.messages.push(next);
    const id = '00000000-0000-4000-8000-000000000008'; input.evidence.push({ ...input.evidence[0]!, id, messageId: 2, excerpt: next.text });
    const value = extractionFixture(); value.contacts[0]!.evidenceIds.push(id); value.contacts[0]!.names = ['Bob']; expect(() => validateExtraction(value, input)).toThrow();
  });
  it('accepts a target-profile-bound authored company introduction without a redundant company object', () => {
    const input = forwarded(); input.messages[0]!.forward.originPeer!.names = ['Noor Mehta']; input.messages[0]!.forward.originPeer!.usernames = ['noor']; text(input, 'Noor from Cedar here. We are reviewing commercial terms in this group.');
    const value = extractionFixture(); value.companies = []; value.companyCandidates = []; value.facts = []; value.contacts[0]!.names = ['Noor Mehta']; value.contacts[0]!.usernames = ['noor']; value.contacts[0]!.roles = []; value.contacts[0]!.phones = ['+11111111111'];
    expect(validateExtraction(value, input).contacts[0]!.affiliation).toBe('external');
    value.contacts[0]!.affiliation = 'internal'; expect(() => validateExtraction(value, input)).toThrow();
  });
  it('retains unknown hidden-forward identity without borrowing outer profile attributes', () => {
    const input = forwarded(); input.messages[0]!.forward.originPeer = null; input.messages[0]!.forward.originName = null;
    expect(() => validateExtraction(extractionFixture(), input)).toThrow('Contact identity');
    const value = extractionFixture(); value.contacts = []; expect(validateExtraction(value, input).contacts).toEqual([]);
  });
  it('accepts explicitly self-attributed contact fields and internal affiliation', () => {
    const input = inputFixture(); text(input, 'I am Mira, CTO at AntSeed. My email is mira@example.invalid. My phone is +11111111111. My username is @new_mira. Cedar Labs will receive notes tomorrow.');
    const value = extractionFixture(); value.contacts[0]!.roles = [{ companyName: 'AntSeed', role: 'CTO', evidenceIds: value.evidenceIds }]; value.contacts[0]!.affiliation = 'internal'; value.contacts[0]!.emails = ['mira@example.invalid']; value.contacts[0]!.phones = ['+11111111111']; value.contacts[0]!.usernames = ['new_mira'];
    expect(validateExtraction(value, input).contacts[0]!.affiliation).toBe('internal');
  });
  it('rejects another named persons fields and roles within the same cited message', () => {
    const input = inputFixture(); text(input, `${input.messages[0]!.text} Bob's email is bob@example.invalid. Bob is CEO at Elm Labs.`);
    const value = extractionFixture(); value.contacts[0]!.emails = ['bob@example.invalid']; expect(() => validateExtraction(value, input)).toThrow();
    value.contacts[0]!.emails = []; value.contacts[0]!.roles = [{ companyName: 'Elm Labs', role: 'CEO', evidenceIds: value.evidenceIds }]; expect(() => validateExtraction(value, input)).toThrow();
  });
  it.each(['1999-01-01T03:21:00Z', '2026-10-18T03:21:00Z'])('rejects arbitrary instant %s for day-only tomorrow', (resolvedAt) => {
    const value = extractionFixture(); Object.assign(value.facts[0]!.dates[0]!, { precision: 'instant', resolvedAt, localDate: null });
    expect(() => validateExtraction(value, inputFixture())).toThrow();
  });
  it('checks both sourced time and source-relative day for an explicit instant', () => {
    const input = inputFixture(); text(input, `${input.messages[0]!.text} Send tomorrow at 10:15 am.`);
    const value = extractionFixture(); const date = value.facts[0]!.dates[0]!; Object.assign(date, { originalText: 'tomorrow at 10:15 am', precision: 'instant', resolvedAt: '2026-10-18T04:45:00Z', localDate: null });
    expect(validateExtraction(value, input).facts[0]!.dates[0]!.resolvedAt).toBe('2026-10-18T04:45:00Z');
    date.resolvedAt = '2026-10-18T04:46:00Z'; expect(() => validateExtraction(value, input)).toThrow();
    date.resolvedAt = '1999-01-01T04:45:00Z'; expect(() => validateExtraction(value, input)).toThrow();
  });
  it('rejects invented phrases and resolved ambiguous kal regardless of selected precision', () => {
    const value = extractionFixture(); value.facts[0]!.dates[0]!.originalText = 'today'; expect(() => validateExtraction(value, inputFixture())).toThrow();
    const input = inputFixture(); text(input, `${input.messages[0]!.text} Kal.`); Object.assign(value.facts[0]!.dates[0]!, { originalText: 'kal', precision: 'instant', localDate: null, resolvedAt: '2026-10-18T00:00:00Z' }); expect(() => validateExtraction(value, input)).toThrow();
  });
  it.each([
    ['Kal subah 10 baje IST contract bhejunga.', '2026-10-17T20:00:00Z', '2026-10-19T04:30:00Z'],
    ['मैं कल सुबह दस बजे IST अनुबंध भेजूँगा।', '2026-10-16T20:00:00Z', '2026-10-18T04:30:00Z'],
  ])('preserves sourced multilingual explicit clock: %s', (source, anchor, resolvedAt) => {
    const input = inputFixture(); text(input, source); input.messages[0]!.sentAt = anchor;
    const value = extractionFixture(); value.contacts = []; value.companies = []; value.companyCandidates = []; value.facts = [];
    value.dates = [{ kind: 'commitment', originalText: source, relativeTo: anchor, timezone: 'Asia/Kolkata', resolvedAt, localDate: null, precision: 'instant', ambiguous: false, evidenceIds: value.evidenceIds }];
    expect(validateExtraction(value, input).dates[0]!.resolvedAt).toBe(resolvedAt);
    value.dates[0]!.resolvedAt = '1999-01-01T04:30:00Z'; expect(() => validateExtraction(value, input)).toThrow();
  });
  it('anchors forwarded dates to the original message date when available', () => {
    const input = forwarded(); input.messages[0]!.forward.originDate = '2026-10-15T20:00:00Z'; const value = extractionFixture();
    expect(() => validateExtraction(value, input)).toThrow('anchor');
    Object.assign(value.facts[0]!.dates[0]!, { relativeTo: '2026-10-15T20:00:00Z', localDate: '2026-10-17' }); expect(validateExtraction(value, input).facts[0]!.dates[0]!.localDate).toBe('2026-10-17');
  });
});
