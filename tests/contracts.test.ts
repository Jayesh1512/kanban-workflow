import { describe, expect, expectTypeOf, it } from 'vitest';
import { API_OPERATIONS, MCP_OPERATIONS } from '../src/shared/api.js';
import { correctMappingSchema, decideProposalSchema, proposeLaneSchema, setInclusionSchema } from '../src/shared/schemas.js';
import { LANES, WORKSTREAMS } from '../src/shared/domain.js';
import type { AnalysisInput, ExtractionCheckpoint, JevDecision, Message, PeerSnapshot, ProviderProvenance, UUID } from '../src/shared/domain.js';
import type { AnalysisJob, AnalysisQueue, DomainServices, ExtractionPort, ProviderResult, RecordsService, TelegramMessageInput } from '../src/shared/ports.js';

type ServiceMethod = { [K in keyof DomainServices]-?: `${K}.${Extract<keyof NonNullable<DomainServices[K]>, string>}` }[keyof DomainServices];
const bindings: readonly { service: ServiceMethod }[] = API_OPERATIONS;
const id = '00000000-0000-4000-8000-000000000001';
const sender: PeerSnapshot = { id: '123', kind: 'user', names: ['Riya Fixture'], usernames: ['riya_fixture'], visiblePhones: ['+10000000001'], visibleEmails: ['riya@example.invalid'], observedAt: '2026-10-17T00:00:00Z' };
const peer: PeerSnapshot = { id: '-1001', kind: 'channel', names: ['Fixture company'], usernames: [], visiblePhones: [], visibleEmails: [], observedAt: '2026-10-17T00:00:00Z' };

describe('shared integration contract', () => {
  it('requires the immutable attempt token on every analysis result write', () => {
    expectTypeOf<Pick<AnalysisJob, 'claimToken'>>().toEqualTypeOf<{ readonly claimToken: string }>();
    expectTypeOf<Parameters<AnalysisQueue['saveExtraction']>>().toEqualTypeOf<[ExtractionCheckpoint, string]>();
    expectTypeOf<Parameters<AnalysisQueue['complete']>>().toEqualTypeOf<[UUID, JevDecision, ProviderProvenance, string]>();
    expectTypeOf<Parameters<AnalysisQueue['fail']>>().toEqualTypeOf<[UUID, Extract<ProviderResult<never>, { ok: false }>, string]>();
    expectTypeOf<Parameters<AnalysisQueue['loadInput']>>().toEqualTypeOf<[UUID]>();
    expectTypeOf<Parameters<AnalysisQueue['getExtraction']>>().toEqualTypeOf<[UUID]>();
  });
  it('preserves identical own and forwarded bodies with unknown original author', () => {
    const own: Message = { chatId: '-1001', id: 1, senderId: '123', sender, peer, sentAt: '2026-10-17T00:00:00Z', editedAt: null, deletedAt: null, text: 'We are live', replyToId: null, sourceUrl: null, version: 1, forward: { isForwarded: false, sourceKind: 'own', originPeer: null, originName: null, originDate: null, originMessageId: null } };
    const forwarded: Message = { ...own, forward: { ...own.forward, isForwarded: true, sourceKind: 'forwarded', originDate: '2026-10-16T00:00:00Z' } };
    expect(own.text).toBe(forwarded.text);
    expect(own.forward).not.toEqual(forwarded.forward);
    expect(forwarded.forward.originPeer).toBeNull();
    expect(forwarded.forward.originName).toBeNull();
  });
  it('exposes available sender and peer snapshots to extraction and context without rewriting text', () => {
    const ingested: TelegramMessageInput = { chatId: '-1001', id: 2, senderId: '123', sender, peer, sentAt: '2026-10-17T00:00:00Z', editedAt: null, text: 'Testing starts today', replyToId: null, sourceUrl: null, forward: { isForwarded: false, sourceKind: 'own', originPeer: null, originName: null, originDate: null, originMessageId: null } };
    const analysis: Pick<AnalysisInput, 'messages'> = { messages: [{ ...ingested, version: 1, deletedAt: null }] };
    const context: Pick<Awaited<ReturnType<RecordsService['getContext']>>, 'messages'> = { messages: analysis.messages };
    type ExtractionMessage = Parameters<ExtractionPort['extract']>[0]['messages'][number];
    expectTypeOf<ExtractionMessage['sender']>().toEqualTypeOf<PeerSnapshot>();
    expectTypeOf<ExtractionMessage['peer']>().toEqualTypeOf<PeerSnapshot>();
    expectTypeOf<(typeof context)['messages'][number]['sender']>().toEqualTypeOf<PeerSnapshot>();
    for (const messages of [analysis.messages, context.messages]) {
      expect(messages[0]!.sender).toEqual(sender);
      expect(messages[0]!.peer).toEqual(peer);
      expect(messages[0]!.sender.names).toEqual(['Riya Fixture']);
      expect(messages[0]!.sender.usernames).toEqual(['riya_fixture']);
      expect(messages[0]!.sender.visiblePhones).toEqual(['+10000000001']);
      expect(messages[0]!.sender.visibleEmails).toEqual(['riya@example.invalid']);
      expect(messages[0]!.text).toBe('Testing starts today');
    }
  });
  it('binds every transport operation to an exported service; Hermes cannot approve', () => {
    expect(bindings.length).toBe(API_OPERATIONS.length);
    expect(new Set(MCP_OPERATIONS.map((op) => op.tool)).size).toBe(MCP_OPERATIONS.length);
    expect(MCP_OPERATIONS.map((op) => String(op.service)).includes('proposals.decide')).toBe(false);
    expect(MCP_OPERATIONS.some((op) => op.service === 'proposals.propose')).toBe(true);
    expect(API_OPERATIONS.find((op) => op.service === 'proposals.decide')?.tool).toBeNull();
  });
  it('rejects unsupported lane, arbitrary instructions and unevidenced movement', () => {
    const input = { idempotencyKey: 'move-1', ticketId: id, expectedStageVersion: 4, targetLane: LANES[2], evidenceIds: [id], reason: 'Testing has begun', nextAction: null, origin: 'hermes' };
    expect(proposeLaneSchema.parse(input).expectedStageVersion).toBe(4);
    for (const change of [{ targetLane: 'Done' }, { evidenceIds: [] }, { execute: 'move directly' }, { expectedStageVersion: -1 }]) {
      expect(proposeLaneSchema.safeParse({ ...input, ...change }).success).toBe(false);
    }
    expect(WORKSTREAMS).toEqual(['Buyer', 'Provider', 'Integration', 'Others']);
  });
  it('requires explicit versioned mapping and correction evidence/reason', () => {
    const mapping = { idempotencyKey: 'map-1', chatId: '-1001234', expectedMappingVersion: 2, companyId: id, status: 'confirmed', evidenceIds: [id], reason: 'Operator confirmed', source: 'http' };
    expect(correctMappingSchema.safeParse(mapping).success).toBe(true);
    expect(correctMappingSchema.safeParse({ ...mapping, status: 'unresolved' }).success).toBe(false);
    expect(correctMappingSchema.safeParse({ ...mapping, companyId: null }).success).toBe(false);
    expect(setInclusionSchema.safeParse({ idempotencyKey: 'exclude-1', chatId: '-1001234', inclusion: 'excluded', expectedPolicyVersion: 3 }).success).toBe(true);
    expect(decideProposalSchema.safeParse({ idempotencyKey: 'correct-1', proposalId: id, decision: 'correct' }).success).toBe(false);
  });
});
