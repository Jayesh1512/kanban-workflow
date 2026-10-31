import { expect, it } from 'vitest';
import { shortAction, workTitle } from '../../src/board/headline.js';

it.each([
  ['Ravi requested that Piyush append the discussed pointers to the document. No acceptance.', 'Append discussed pointers to document'],
  ['Kingsley asked AntSeed to have affected customers retry after the fix. Shahaf acknowledged.', 'Have affected customers retry'],
  ['Ravi said he would pay from his own wallet for now.', 'Pay from own wallet'],
])('turns "%s" into a short complete action', (source, expected) => { expect(shortAction(source)).toBe(expected); });

it('uses the stored headline when there is no clear action, and a neutral prompt otherwise', () => {
  expect(workTitle(null, 'Intro call postponed to Nov 2')).toBe('Intro call postponed to Nov 2');
  expect(workTitle('Ravi requested feedback on their integration experience; no feedback is supplied.', 'Wary of switching AI spend')).toBe('Wary of switching AI spend');
  expect(workTitle('Ravi said he would pay from his own wallet for now.', 'Onboarding transfer')).toBe('Pay from own wallet');
  expect(workTitle(null, null)).toBe('Review conversation');
});

it('does not treat a request Ravi made of someone else as Ravi’s own task', async () => {
  const { requestedByOwner } = await import('../../src/workflow/records.js');
  expect(requestedByOwner('Ravi requested that Piyush append the discussed pointers to the document.', 'ravi')).toBe(true);
  expect(requestedByOwner('Ravi asked @lstern10 to evaluate the proposal.', 'ravi')).toBe(true);
  expect(requestedByOwner('Kingsley asked AntSeed to have affected customers retry.', 'ravi')).toBe(false);
  expect(requestedByOwner('Ravi proposed discussing a Devcon-focused integration.', 'ravi')).toBe(true);
  expect(requestedByOwner('Ravi expressed interest in connecting on Tuesday.', 'ravi')).toBe(true);
  expect(requestedByOwner('Ravi said he would pay from his own wallet.', 'ravi')).toBe(false);
});
