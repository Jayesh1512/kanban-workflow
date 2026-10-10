// Accepted application bounds; provider adapters enforce complete serialized-envelope byte caps.
export const GENERAL_LIMITS = {
  recentMessages: 20,
  otherChatCards: 10,
  companies: 15,
  messageExcerptBytes: 16384,
  requestBytes: 1048576,
  responseBytes: 1048576,
} as const;
export const MOVEMENT_LIMITS = {
  evidenceMessages: 21,
  evidenceExcerptBytes: 4096,
  stateBytes: 65536,
  requestBytes: 262144,
  responseBytes: 1048576,
  transitions: 253,
  questions: 255,
  supportOptions: 23,
} as const;
