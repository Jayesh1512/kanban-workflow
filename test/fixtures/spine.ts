import type { FixtureLine, ScriptDecision, ScriptLine } from '../../src/contracts/index.ts';

const base: ScriptDecision = {
  disposition: 'none',
  card: null,
  proposal: null,
  lane: null,
  title: null,
  summary: null,
  cardCompany: null,
  confidence: 1,
  reason: 'Sales SOP: a client requests an integration',
  move: null,
  contacts: [],
  mentions: [],
};
export function spineRecording(): FixtureLine[] {
  const lines: FixtureLine[] = [
    { t: 'account', account: 'alice', self: { userKey: 'u-alice', displayName: 'Alice', handle: null } },
    {
      t: 'chat',
      account: 'alice',
      chat: { key: 'client', nativeId: 'client', kind: 'group', title: 'Acme integration' },
    },
    {
      t: 'chat',
      account: 'alice',
      chat: { key: 'excluded', nativeId: 'excluded', kind: 'direct', title: 'Unselected' },
    },
    { t: 'mark', name: 'setup' },
  ];
  for (let n = 1; n <= 12; n++)
    lines.push({
      t: 'message',
      account: 'alice',
      delivery: 'live',
      chatKey: 'client',
      message: {
        key: `m-${n}`,
        nativeId: `n-${n}`,
        cursor: String(n).padStart(4, '0'),
        sender:
          n <= 6
            ? { userKey: 'u-bob', displayName: 'Bob', handle: null }
            : { userKey: 'u-dana', displayName: 'Dana', handle: null },
        sentAt: `2026-09-01T10:00:${String(n).padStart(2, '0')}.000Z`,
        text: n <= 6 ? 'Please integrate our technical system.' : 'I handle the invoice for this integration.',
        media: null,
        replyToNativeId: null,
        editedAt: null,
      },
    });
  lines.push({ t: 'mark', name: 'delivered' });
  return lines;
}
export function spineScript(): ScriptLine[] {
  return Array.from(
    { length: 12 },
    (_, index): ScriptLine => ({
      messageKey: `m-${index + 1}`,
      version: 1,
      decision: {
        ...base,
        disposition: index === 0 ? 'create' : 'join',
        proposal: index === 0 ? null : 'm-1',
        lane: index === 0 ? 'Sales' : null,
        title: index === 0 ? 'Acme <integration>' : null,
        summary: index === 0 ? 'Integrate the client system.' : null,
        contacts:
          index === 0
            ? [
                {
                  userKey: 'u-bob',
                  company: 'Acme',
                  companyConfidence: 1,
                  roleCategory: 'technical',
                  dealsAbout: 'system integration',
                  roleConfidence: 1,
                  evidenceMessageKeys: ['m-1'],
                },
              ]
            : [],
      },
    }),
  );
}
