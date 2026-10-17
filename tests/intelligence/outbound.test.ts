import { describe, expect, it } from 'vitest';
import { outreachContext } from '../../src/shared/outreach.js';
import { buildOpenAIDecisionsRequest, parseOpenAIDecisions } from '../../src/intelligence/openai-decisions.js';
import { validateExtraction } from '../../src/intelligence/validation.js';
import { outbound, recommendation, reply } from './outbound-fixtures.js';

describe('outbound-first source and deterministic stage rules', () => {
  it('identifies the AntSeed sender and projects explicit awaiting-reply context', () => {
    const input = outbound(); expect(outreachContext(input.messages, input.accountSelfId)).toMatchObject({ initiatedBy: 'antseed', waitingForReply: true, lastOutgoingAt: input.messages[0]!.sentAt, lastIncomingAt: null });
    expect(JSON.parse(buildOpenAIDecisionsRequest(input).input).state).toMatchObject({ accountSelfId: '99', outreach: { waitingForReply: true } });
  });
  it.each(['lane_1', 'lane_2', 'lane_5'] as const)('blocks a confident %s advance based only on our first enquiry', target => {
    const input = outbound(); validateExtraction(input.extraction, input);
    expect(parseOpenAIDecisions(recommendation(target), input)).toMatchObject({ companyMatch: { outcome: 'new_company' }, lane: { outcome: 'no_change' } });
  });
  it('treats To be started as the initial lane instead of proposing a move to the same new-ticket lane', () => {
    expect(parseOpenAIDecisions(recommendation('lane_0'), outbound()).lane.outcome).toBe('no_change');
  });
  it('permits a sourced positive recipient reply to generate a proposal, never an applied move', () => {
    const input = reply(); validateExtraction(input.extraction, input);
    expect(outreachContext(input.messages, input.accountSelfId)).toMatchObject({ waitingForReply: false, lastIncomingAt: input.messages[1]!.sentAt });
    expect(parseOpenAIDecisions(recommendation(), input).lane).toMatchObject({ outcome: 'propose', targetLane: 'Work in progress' });
  });
  it.each(['forward', 'internal', 'deleted', 'uncited'] as const)('does not count a %s incoming message as recipient engagement', kind => {
    const input = reply(), m = input.messages[1]!;
    if (kind === 'forward') m.forward = { ...m.forward, isForwarded: true, sourceKind: 'forwarded', originPeer: m.sender };
    if (kind === 'internal') input.extraction.contacts[0]!.affiliation = 'internal';
    if (kind === 'deleted') m.deletedAt = '2026-10-17T02:00:00Z';
    if (kind === 'uncited') input.extraction.evidenceIds = [input.evidence[0]!.id];
    expect(parseOpenAIDecisions(recommendation(), input).lane.outcome).toBe('no_change');
  });
  it('extracts the visible DM recipient contact without borrowing our phone or self-introduction', () => {
    const input = outbound(); expect(validateExtraction(input.extraction, input).contacts[0]).toMatchObject({ telegramUserIds: ['7'], names: ['Mira'], phones: ['+11111111111'] });
    input.extraction.contacts[0]!.phones = ['+22222222222']; expect(() => validateExtraction(input.extraction, input)).toThrow('target identity');
    input.extraction.contacts[0]!.phones = []; input.extraction.contacts[0]!.names = ['Ravi']; expect(() => validateExtraction(input.extraction, input)).toThrow('target identity');
  });
  it('does not infer an outreach author without account identity or from a forwarded claim', () => {
    const input = outbound(); expect(outreachContext(input.messages)).toMatchObject({ initiatedBy: 'unknown', waitingForReply: false });
    input.messages[0]!.forward.isForwarded = true; expect(outreachContext(input.messages, input.accountSelfId)).toMatchObject({ initiatedBy: 'unknown', lastOutgoingAt: null });
  });
});
