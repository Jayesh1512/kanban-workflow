import type { ReplaySetup } from './types.ts';

export const REPLAY_START = '2026-10-10T10:00:00.000Z';
export const WITHDRAWAL_MARKER = 'E1R_WITHDRAW_ONLY_7QX';
// Fifteen names share the generic word Group, exposing frozen candidate
// saturation without silently changing the graph matching rules.
export const COMPANY_NAMES = [
  'Acme Systems Group',
  'Globex Logistics Group',
  'Northstar Labs Group',
  'Cedar Works Group',
  'Bluebird Studio Group',
  'Atlas Supply Group',
  'Harbor Devices Group',
  'Orchid Services Group',
  'Copper Networks Group',
  'Juniper Design Group',
  'Willow Foods Group',
  'Redwood Partners Group',
  'Meridian Tools Group',
  'Summit Research Group',
  'The Global Group',
  `${WITHDRAWAL_MARKER} Company`,
] as const;
export const ROLE_CATEGORIES = [
  'sales',
  'technical',
  'finance',
  'operations',
  'support',
  'leadership',
  'other',
  'unknown',
];
export function chatKey(chat: number): string {
  return `chat-${String(chat + 1).padStart(3, '0')}`;
}
export function messageKey(chat: number, message: number): string {
  return `m-${String(chat + 1).padStart(3, '0')}-${String(message + 1).padStart(3, '0')}`;
}
export function accountFor(chat: number): string {
  return chat % 2 === 0 ? 'alice' : 'bob';
}
export function companyFor(chat: number): string | null {
  // Unknown-evidence contacts have no named company. The withdrawal marker company
  // occurs only in chat 016, so later physical purge checks can scan it honestly.
  // Uncertain nonwork chat 080 shares that contact but adds no human company link.
  if (chat === 79) return null;
  if (chat === 1) return COMPANY_NAMES[0];
  if (chat % 64 >= 60) return null;
  const index = chat % 16;
  return index === 15 && chat !== 15 ? COMPANY_NAMES[0] : (COMPANY_NAMES[index] ?? null);
}
export function senderFor(chat: number): string {
  return `u-contact-${String(chat === 1 ? 1 : (chat % 64) + 1).padStart(3, '0')}`;
}
export function buildSetup(threshold = 0.8): ReplaySetup {
  return {
    teammates: [
      { username: 'alice', account: 'alice' },
      { username: 'bob', account: 'bob' },
    ],
    lanes: [
      {
        name: 'Sales',
        sop: 'Track a client requesting a quote for a new purchase. Shipping and invoicing evidence may need human review.',
        stages: [
          { name: 'Lead', criteria: 'A client asks about a purchase.' },
          { name: 'Quoted', criteria: 'A written quote has been sent.' },
          { name: 'Agreed', criteria: 'The client approves the quote.' },
        ],
      },
      {
        name: 'Shipping',
        sop: 'Track an accepted order explicitly assigned to shipment.',
        stages: [
          { name: 'Queued', criteria: 'An accepted order is queued for shipment.' },
          { name: 'Packed', criteria: 'Packing is complete.' },
          { name: 'In transit', criteria: 'The carrier has collected the package.' },
          { name: 'Done', criteria: 'The customer confirms delivery.' },
        ],
      },
      {
        name: 'Finance',
        sop: 'Track an invoice explicitly assigned to finance for collection.',
        stages: [
          { name: 'Open', criteria: 'An invoice has been issued.' },
          { name: 'Paid', criteria: 'The invoice payment has cleared.' },
        ],
      },
    ],
    included: [
      ...Array.from({ length: 80 }, (_, chat) => ({
        account: accountFor(chat),
        chatKey: chatKey(chat),
        company: companyFor(chat),
      })),
      { account: 'bob', chatKey: chatKey(0), company: companyFor(0) },
    ],
    settings: {
      review_threshold: threshold,
      require_agreement: true,
      role_categories: [...ROLE_CATEGORIES],
      keep_deleted_text: true,
    },
  };
}
