import { describe, expect, it } from 'vitest';
import type { BusinessFact } from '../../src/shared/domain.js';
import type { OutreachDetail, OutreachSourceContext } from '../../src/shared/outreach-domain.js';
import { redactionCard, reviewCard, salesCard } from '../../src/outreach/card-format.js';

const actor = { party: 'external' as const, contactId: 'contact-1', displayName: 'Mira' };
const fact = (id: string, kind: BusinessFact['kind'], text: string, dates: BusinessFact['dates'] = []): BusinessFact => ({
  id, kind, text, actor, state: 'open', answersFactId: null, dates, evidenceIds: ['evidence-1'], version: 1, source: 'inferred',
});
const source: OutreachSourceContext = {
  id: 'source-1', kind: 'telegram', chatId: '-1001', ticketId: 'ticket-1', title: 'AntSeed <> Cedar',
  operationalLane: 'Work in progress', nextAction: 'Send pilot pricing', hasOutbound: true,
  enrollmentState: 'active', eligible: true, sourceRevision: 'r1', latestSourceAt: '2026-10-25T12:00:00.000Z',
  contacts: [{ id: 'contact-1', names: ['Mira'], usernames: ['mira'], roles: ['CTO', 'Decision maker'], emails: ['mira@cedar.example'], phones: [], affiliation: 'external', evidenceIds: ['evidence-1'] }],
  facts: [
    fact('fact-budget', 'fact', 'Cedar requested pilot pricing and contract terms.'),
    fact('fact-need', 'fact', 'Cedar needs a low-latency inference endpoint for production traffic.'),
    fact('fact-risk', 'blocker', 'Security review is pending.'),
    fact('fact-date', 'commitment', 'Mira will review the pilot contract on Friday.', [{ kind: 'commitment', originalText: 'Friday', relativeTo: '2026-10-25T12:00:00.000Z', timezone: 'Asia/Kolkata', resolvedAt: null, localDate: '2026-10-30', precision: 'date', ambiguous: false, evidenceIds: ['evidence-1'] }]),
  ],
  evidence: [{ id: 'evidence-1', excerpt: 'Please send pricing. <script>alert(1)</script>', sourceUrl: 'https://t.me/c/1/2', observedAt: '2026-10-25T12:00:00.000Z' }],
  coverage: { evidenceLimit: 100, factLimit: 100, truncated: false },
};
const detail: OutreachDetail = {
  relationship: {
    id: 'relationship-1', kind: 'company', companyId: 'company-1', displayName: 'Cedar', title: 'Cedar', nextStep: 'Next: Send pilot pricing · ETA: Not set', summary: '', workstream: 'Buyer',
    acceptedStage: 'qualification', displayStage: 'qualification', stageBasis: 'accepted', stageReason: 'Active fit evaluation', stageVersion: 1,
    evidenceRevision: 2, disposition: 'pipeline', sourceCount: 1, pendingSourceCount: 0, latestSourceAt: '2026-10-25T12:00:00.000Z', reconciledAt: '2026-10-25T12:01:00.000Z', sourceState: 'current',
  },
  activeSources: [source], pendingSources: [], suspendedSources: [], limits: [],
  actions: [{ id: 'action-1', text: 'Send pilot pricing', actor: 'antseed', state: 'open', precision: 'date', localDate: '2026-10-28', instant: null, timezone: 'Asia/Kolkata', version: 1 }],
};

describe('CRM business card format', () => {
  it('renders a complete evidence-backed opportunity record with definitions and controls', () => {
    const card = salesCard({ snapshot: detail, stage: 'qualification', action: 'Send pilot pricing', marker: '[antseed-relationship:relationship-1]', generation: '[antseed-projection:relationship-1:g0]' });
    expect(card.title).toBe('Cedar: Cedar requested pilot pricing and contract terms. · Next: Send pilot pricing · ETA: 2026-10-28');
    for (const heading of ['Opportunity summary', 'Pipeline stage', 'Next step', 'Qualification (BANT)', 'Commercial terms', 'Stakeholders and contacts', 'Customer need and proposed solution', 'Risks, blockers and open questions', 'Approved conversation evidence', 'Record controls']) {
      expect(card.description).toContain(`<h2>${heading}</h2>`);
    }
    const ordered = ['Opportunity summary', 'Pipeline stage', 'Next step', 'Qualification (BANT)', 'Commercial terms', 'Stakeholders and contacts', 'Customer need and proposed solution', 'Risks, blockers and open questions', 'Approved conversation evidence', 'Record controls'].map(heading => card.description.indexOf(`<h2>${heading}</h2>`));
    expect(ordered).toEqual([...ordered].sort((a,b)=>a-b));
    expect(card.description).toContain('Budget — money approved or available');
    expect(card.description).toContain('Authority — person or committee able to approve');
    expect(card.description).toContain('Mira (CTO, Decision maker)');
    expect(card.description).toContain('2026-10-28 (Asia/Kolkata; date only)');
    expect(card.description).toContain('Security review is pending.');
    expect(card.description).toContain('Estimated deal value:</strong> Not established from approved evidence');
    expect(card.description).toContain('[antseed-crm-template:v2]');
    expect(card.description).not.toContain('<script>');
    expect(card.description).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('does not invent amount, probability, close date, authority or solution from a stage', () => {
    const empty = structuredClone(detail);
    empty.activeSources[0]!.facts = [];
    empty.activeSources[0]!.contacts = [];
    empty.actions = [];
    const card = salesCard({ snapshot: empty, stage: 'negotiation', action: 'Next action not recorded', marker: '[antseed-relationship:r]', generation: '[antseed-projection:r:g1]' });
    expect(card.description.match(/Not established from approved evidence/g)?.length).toBeGreaterThanOrEqual(10);
    expect(card.description).toContain('Probability / forecast category:</strong> Not established from approved evidence');
    expect(card.description).toContain('Expected close date:</strong> Not established from approved evidence');
    expect(card.description).toContain('Move to Deal Won only after an evidenced commercial commitment');
  });

  it('keeps review cards useful without publishing unapproved claims', () => {
    const card = reviewCard('Cedar <Review>', 'relationship-1', '[antseed-projection:relationship-1:g0]', 2);
    expect(card.title).toBe('Cedar <Review>: Initial sales stage awaiting review · Next: Review initial sales stage · ETA: Not set');
    expect(card.description).toContain('Accepted sales stage:</strong> Not approved');
    expect(card.description).toContain('no commercial stage or source enrollment has been approved');
    expect(card.description).toContain('[antseed-crm-template:v2]');
    expect(card.description).not.toContain('<Review>');
  });

  it('uses the same business format after stale source claims are redacted', () => {
    const card = redactionCard('Cedar', 'qualification', '[antseed-relationship:r]', '[antseed-projection:r:g0]');
    expect(card.title).toBe('Cedar: Approved source context changed · Next: Review changed sources · ETA: Not set');
    expect(card.description).toContain('<h2>Commercial terms</h2>');
    expect(card.description).toContain('Accepted sales stage:</strong> Qualification');
    expect(card.description).toContain('The accepted sales stage has not changed');
    expect(card.description).toContain('[antseed-crm-template:v2]');
    expect(card.description).not.toContain('Mira');
  });
});
