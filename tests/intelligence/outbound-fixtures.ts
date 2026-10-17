import { extractionFixture, inputFixture } from './fixtures.js';
import { nativeDecisionFixture } from './decision-fixtures.js';
import { LANES } from '../../src/shared/domain.js';
export function outbound() {
  const input = inputFixture(), extraction = extractionFixture(); input.accountSelfId = '99'; input.chat.id = '7'; input.chat.kind = 'user'; input.chat.title = 'Mira';
  const m = input.messages[0]!; m.chatId = '7'; m.senderId = '99'; m.sender = { ...m.sender, id: '99', names: ['Ravi'], usernames: ['ravi'], visiblePhones: ['+22222222222'] }; m.peer = { ...m.sender, id: '7', names: ['Mira'], usernames: ['mira'], visiblePhones: ['+11111111111'] };
  m.text = 'Hi Mira at Cedar Labs, I am Ravi at AntSeed. Would Cedar Labs like to evaluate AntSeed API services?';
  input.evidence[0]!.chatId = '7'; input.evidence[0]!.excerpt = m.text;
  extraction.facts = []; extraction.dates = []; extraction.contacts = [{ telegramUserIds: ['7'], names: ['Mira'], usernames: ['mira'], phones: ['+11111111111'], emails: [], roles: [], affiliation: 'unknown', evidenceIds: extraction.evidenceIds }];
  extraction.summary = 'AntSeed sent a first enquiry to Cedar Labs; awaiting a response.';
  return { ...input, extraction };
}
export function recommendation(target: 'lane_0' | 'lane_1' | 'lane_2' | 'lane_5' = 'lane_1') {
  const raw = nativeDecisionFixture(), lane = raw.answers.find(a => a.name === 'lane')!, supported = raw.answers.find(a => a.name === 'supported')!;
  if (lane.type === 'choice') { const label=LANES[Number(target.slice(5))]!;lane.choice = label; lane.probabilities = lane.probabilities.map(p => ({ ...p, probability: p.value === label ? 1 : 0 })); }
  if (supported.type === 'predicate') supported.probability = 1;
  return raw;
}
export function reply() {
  const input = outbound(), m = input.messages[0]!;
  input.messages.push({ ...m, id: 2, senderId: '7', sender: m.peer, text: 'Yes, Cedar Labs is interested. Please send pricing and engineering will review.', sentAt: '2026-10-17T01:00:00.000Z' });
  const evidence = { ...input.evidence[0]!, id: '00000000-0000-4000-8000-000000000088', messageId: 2, excerpt: input.messages[1]!.text, observedAt: input.messages[1]!.sentAt };
  input.evidence.push(evidence); input.extraction.evidenceIds = [...input.extraction.evidenceIds, evidence.id]; return input;
}
