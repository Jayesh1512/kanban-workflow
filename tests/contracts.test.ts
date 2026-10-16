import { describe, expect, it } from 'vitest';
import { API_OPERATIONS, MCP_OPERATIONS } from '../src/shared/api.js';
import { correctMappingSchema, decideProposalSchema, proposeLaneSchema, setInclusionSchema } from '../src/shared/schemas.js';
import { LANES, WORKSTREAMS } from '../src/shared/domain.js';
import type { Message } from '../src/shared/domain.js';
import type { DomainServices } from '../src/shared/ports.js';

type ServiceMethod = { [K in keyof DomainServices]: `${K}.${Extract<keyof DomainServices[K], string>}` }[keyof DomainServices];
const bindings: readonly { service: ServiceMethod }[] = API_OPERATIONS;
const id = '00000000-0000-4000-8000-000000000001';

describe('shared integration contract', () => {
  it('preserves identical own and forwarded bodies with unknown original author', () => {
    const own: Message = { chatId: '-1001', id: 1, senderId: '123', sentAt: '2026-10-17T00:00:00Z', editedAt: null, deletedAt: null, text: 'We are live', replyToId: null, sourceUrl: null, version: 1, forward: { isForwarded: false, sourceKind: 'own', originPeer: null, originName: null, originDate: null, originMessageId: null } };
    const forwarded: Message = { ...own, forward: { ...own.forward, isForwarded: true, sourceKind: 'forwarded', originDate: '2026-10-16T00:00:00Z' } };
    expect(own.text).toBe(forwarded.text);
    expect(own.forward).not.toEqual(forwarded.forward);
    expect(forwarded.forward.originPeer).toBeNull();
    expect(forwarded.forward.originName).toBeNull();
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
