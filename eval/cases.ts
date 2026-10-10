import { chatKey, messageKey, WITHDRAWAL_MARKER } from './setup.ts';

// E2 instructions identify existing fixture marks and names, never extra consumer
// fields in recording/setup/script/movement/labels. These are planned cases, not passes.
export const RECORDING_CASES = {
  sharedGroup: { chatKey: chatKey(0), accounts: ['alice', 'bob'] },
  crossChatCard: { chatKeys: [chatKey(0), chatKey(1)], createdByMessageKey: messageKey(0, 0) },
  lowConfidence: { chatKey: chatKey(78), messageKeys: Array.from({ length: 30 }, (_, n) => messageKey(78, n)) },
  uncertainNonwork: {
    chatKey: chatKey(79),
    messageKeys: Array.from({ length: 10 }, (_, n) => messageKey(79, n)),
    dismissAt: 'uncertain-dismiss',
    nextMessageKey: messageKey(79, 10),
  },
  recovery: { chatKey: chatKey(76), afterPages: 1, times: 1, failedAt: 'catchup-failed', restartAt: 'after-restart' },
  lateChat: { chatKey: chatKey(75), appearsAt: 'new-chat-visible', includeAt: 'new-chat-visible' },
  lateInclusion: {
    chatKey: chatKey(77),
    includeAt: 'include-with-history',
    olderKey: messageKey(77, 0),
    newerKey: messageKey(77, 1),
    clock: '2026-10-10T10:00:00.000Z',
  },
  newGroupSpeaker: { chatKey: chatKey(0), userKey: 'u-new-group-speaker', messageKey: messageKey(0, 7) },
  withdrawal: { chatKey: chatKey(15), at: 'before-withdrawal', lateAt: 'after-withdrawal', marker: WITHDRAWAL_MARKER },
  storedEdit: { messageKey: messageKey(4, 2), at: 'stored-edit-delete', reEvaluation: 'not built' },
  storedDelete: { messageKey: messageKey(5, 2), at: 'stored-edit-delete', reEvaluation: 'not built' },
} as const;
export const MOVEMENT_CASES = [
  { name: 'finance-bound-m2-shipping-m1', chat: 69, message: 3, mode: 'finance' },
  { name: 'stay-confident', chat: 69, message: 4, mode: 'stay' },
  { name: 'stay-low-confidence-probability-0.4', chat: 69, message: 5, mode: 'low' },
  { name: 'stay-applicable-support-review', chat: 69, message: 6, mode: 'support-review' },
  { name: 'movement-review-conflicting-evidence', chat: 69, message: 7, mode: 'review' },
  { name: 'unselected-support-review-ignored', chat: 69, message: 8, mode: 'unselected-review' },
  { name: 'invalid-destination', chat: 69, message: 9, mode: 'invalid-destination' },
  { name: 'invalid-distribution', chat: 70, message: 3, mode: 'invalid-distribution' },
  { name: 'invalid-missing-answer', chat: 70, message: 4, mode: 'missing-answer' },
  { name: 'invalid-generic-support', chat: 70, message: 5, mode: 'generic-support' },
  { name: 'invalid-extra-answer', chat: 70, message: 6, mode: 'extra-answer' },
  { name: 'unavailable', chat: 70, message: 7, mode: 'unavailable' },
  { name: 'timeout', chat: 70, message: 8, mode: 'timeout' },
  { name: 'stale', chat: 70, message: 9, mode: 'stale' },
  { name: 'human-override-old-evidence', chat: 71, message: 3, mode: 'human-override' },
  { name: 'strict-threshold-equality', chat: 71, message: 4, mode: 'equality' },
  { name: 'default-one-uncertain-stay', chat: 71, message: 5, mode: 'default-one' },
  { name: 'new-card-review', chat: 72, message: 0, mode: 'review' },
  { name: 'open-proposal-join-review-clears-inherited-move', chat: 78, message: 1, mode: 'review' },
  { name: 'settled-proposal-join-stay', chat: 78, message: 29, mode: 'stay' },
  { name: 'no-destination', chat: 73, message: 3, mode: 'no-destination' },
  { name: 'contradictory-shipping-and-finance', chat: 73, message: 4, mode: 'review' },
  { name: 'mismatched-normalized-target', chat: 73, message: 5, mode: 'invalid_response' },
] as const;
export type RawMode =
  | 'finance'
  | 'stay'
  | 'low'
  | 'support-review'
  | 'review'
  | 'unselected-review'
  | 'invalid-destination'
  | 'invalid-distribution'
  | 'missing-answer'
  | 'generic-support'
  | 'extra-answer';
