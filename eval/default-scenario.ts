import { RECORDING_CASES } from './cases.ts';
import { buildDataset } from './dataset.ts';
import { buildSetup } from './setup.ts';
import type { ReplayDataset } from './types.ts';

// Separate fresh-default setup uses the grouped create/join scenario, so no
// ScriptLine assumes an automatically allocated card while threshold is one.
// The integration-owned active twelve-message/default-one HTTP spine stays active.
export function defaultScenario(): ReplayDataset {
  const data = buildDataset();
  const keys = new Set<string>(RECORDING_CASES.lowConfidence.messageKeys);
  const chat = RECORDING_CASES.lowConfidence.chatKey;
  const setup = buildSetup(1);
  return {
    setup: { ...setup, included: setup.included.filter((entry) => entry.chatKey === chat) },
    recording: data.recording.filter(
      (line) =>
        line.t === 'config' ||
        line.t === 'account' ||
        (line.t === 'chat' && line.chat.key === chat) ||
        (line.t === 'message' && keys.has(line.message.key)) ||
        (line.t === 'mark' && (line.name === 'setup' || line.name === 'end')),
    ),
    script: data.script.filter((line) => keys.has(line.messageKey)),
    movement: data.movement.filter((line) => keys.has(line.messageKey)),
    labels: {
      messages: Object.fromEntries(Object.entries(data.labels.messages).filter(([key]) => keys.has(key))),
      cards: Object.fromEntries(Object.entries(data.labels.cards).filter(([, card]) => card.chatKeys.includes(chat))),
      contacts: Object.fromEntries(Object.entries(data.labels.contacts).filter(([key]) => key === 'u-contact-015')),
      mentions: [],
      companies: data.labels.companies,
      injections: [],
    },
  };
}
